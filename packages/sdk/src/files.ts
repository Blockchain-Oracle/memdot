import {
  bitswapGet,
  cidOf,
  contentHashFromCid,
  quoteStoreFee,
  storageEventsAt,
  toHex,
} from "@memdot/chain";
import { BITSWAP_TIMEOUT_MS, TINY_FILE_BYTES } from "@memdot/config";
import {
  buildManifest,
  decryptObject,
  encryptObject,
  type FileManifest,
  manifestObjectKey,
  openManifest,
  openSegment,
  sealManifest,
  sealSegment,
  sealTo,
} from "@memdot/crypto";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import type { Context, Schemas } from "./context.js";
import { MemDotError } from "./errors.js";
import type { Job, JobsApi } from "./jobs.js";
import type { SpacesApi } from "./spaces.js";
import { openText } from "./spaces.js";
import { storeObject } from "./store.js";
import { unwrap } from "./transport.js";
import type { Wallet } from "./wallet.js";

export type RawObject = Schemas["Object"];
export type ObjectDetail = Schemas["ObjectDetail"];

/** Sealed with the space key: what a listing shows without fetching the manifest. */
interface FileMeta {
  name: string;
  mime: string;
  size: number;
}

export interface FileInfo extends Omit<RawObject, "encryptedMeta"> {
  /** Decrypted on this device; null while locked or when the key is not yours. */
  name: string | null;
  mime: string | null;
  size: number | null;
}

/** A file in a listing: when it leaves the chain unless renewed (the keeper renews it first). */
export interface ListedFile extends FileInfo {
  expiresAtBlock: number | null;
}

export interface PutOptions {
  spaceId: string;
  folderId?: string;
  name: string;
  mime?: string;
  /** Makes this a new version of an existing file. */
  previousVersionId?: string;
  /** Self-signed spaces: the wallet signs each store. */
  wallet?: Wallet;
  /** Retry-safe key; one is generated if omitted. */
  idempotencyKey?: string;
  /** Wait until every blob is finalized on chain (default true). */
  wait?: boolean;
  onProgress?: (job: Job) => void;
}

export interface PutResult {
  file: FileInfo;
  job: Job;
}

export interface VerifyResult {
  ok: boolean;
  blobs: {
    cid: string;
    /** The bytes a node returned hash to the CID. */
    retrievable: boolean;
    /** The block's TransactionStorage events hold this content hash at this location. */
    onChain: boolean;
    block: number | null;
    index: number | null;
  }[];
}

/** Bytes of a typical sealed manifest; only used to estimate fees before encrypting. */
const MANIFEST_ESTIMATE_BYTES = 700;

export async function openFileInfo(raw: RawObject, identities: string[]): Promise<FileInfo> {
  const { encryptedMeta, ...rest } = raw;
  const text = await openText(encryptedMeta, identities);
  const meta = text ? (JSON.parse(text) as FileMeta) : null;
  return { ...rest, name: meta?.name ?? null, mime: meta?.mime ?? null, size: meta?.size ?? null };
}

/**
 * Reads one file's plaintext given the identities that open its manifest or segment. Used for
 * your own files and, through a grant, for files shared with you.
 */
export async function readObject(
  ctx: Context,
  detail: ObjectDetail,
  identities: string[],
  loadSegment: (segmentId: string) => Promise<ObjectDetail>,
  manifest?: FileManifest,
): Promise<{ data: Uint8Array; name: string; mime: string }> {
  if (detail.segmentId) {
    const segment = await loadSegment(detail.segmentId);
    if (!segment.cid) throw new MemDotError(409, "NOT_STORED", "The segment is not stored yet.");
    const entries = await openSegment(
      await ctx.transport.bytes(`/v1/cids/${segment.cid}`),
      identities,
    );
    const entry = entries.find((e) => e.id === detail.id);
    if (!entry) throw new MemDotError(404, "NOT_FOUND", "The file is missing from its segment.");
    return { data: entry.data, name: entry.name ?? "", mime: entry.mime ?? "" };
  }
  if (!detail.cid) throw new MemDotError(409, "NOT_STORED", "The file is not stored yet.");
  const opened =
    manifest ??
    (await openManifest(await ctx.transport.bytes(`/v1/cids/${detail.cid}`), identities));
  const chunks = await Promise.all(
    opened.chunks.map((chunk) => ctx.transport.bytes(`/v1/cids/${chunk.cid}`)),
  );
  return {
    data: await decryptObject(chunks, manifestObjectKey(opened), opened.size),
    name: opened.name,
    mime: opened.mime,
  };
}

export class FilesApi {
  /** Each space's current key epoch, learned as files are read and written. */
  private readonly epochs = new Map<string, number>();

  constructor(
    private readonly ctx: Context,
    private readonly spaces: SpacesApi,
    private readonly jobs: JobsApi,
  ) {}

  /**
   * Encrypts and stores a file. Files under 64 KiB go into a segment (one stored blob, one
   * renewal); larger ones become chunks plus a sealed manifest. By default waits until every blob
   * is finalized on Portaldot V3.
   */
  async put(data: Uint8Array, options: PutOptions): Promise<PutResult> {
    const space = await this.spaces.raw(options.spaceId);
    this.epochs.set(space.id, space.keyEpoch);
    const recipient = this.ctx.vault.sealTo(space.id, space.keyEpoch);
    const meta: FileMeta = {
      name: options.name,
      mime: options.mime ?? "application/octet-stream",
      size: data.length,
    };
    const encryptedMeta = await sealTo(utf8ToBytes(JSON.stringify(meta)), [recipient]);
    const wallet = space.mode === "self_signed" ? requireWallet(options.wallet) : undefined;

    let fileId: string;
    let jobId: string;
    if (data.length <= TINY_FILE_BYTES && !options.previousVersionId) {
      // A tiny file is a one-entry segment: one blob on chain instead of a manifest and a chunk.
      const entryId = crypto.randomUUID();
      const segment = await sealSegment(
        [{ id: entryId, kind: "file", name: meta.name, mime: meta.mime, data }],
        recipient,
      );
      const declared = await storeObject(this.ctx, {
        kind: "segment",
        spaceId: space.id,
        keyEpoch: space.keyEpoch,
        sizeBytes: segment.length,
        root: segment,
        ...(options.folderId ? { folderId: options.folderId } : {}),
        ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
        ...(wallet ? { wallet } : {}),
      });
      await unwrap(
        this.ctx.transport.api.POST("/v1/objects/{id}/entries", {
          params: { path: { id: declared.object.id } },
          body: {
            entries: [
              {
                id: entryId,
                encryptedMeta: toBase64(encryptedMeta),
                sizeBytes: data.length,
                ...(options.folderId ? { folderId: options.folderId } : {}),
              },
            ],
          },
        }),
      );
      fileId = entryId;
      jobId = declared.job.id;
    } else {
      const encrypted = await encryptObject(data);
      const manifest = buildManifest({
        name: meta.name,
        mime: meta.mime,
        size: encrypted.size,
        paddedSize: encrypted.paddedSize,
        objectKey: encrypted.objectKey,
        chunks: encrypted.chunks.map((chunk) => ({ cid: cidOf(chunk), bytes: chunk.length })),
        createdAt: new Date().toISOString(),
      });
      const declared = await storeObject(this.ctx, {
        kind: "file",
        spaceId: space.id,
        keyEpoch: space.keyEpoch,
        encryptedMeta,
        sizeBytes: encrypted.paddedSize,
        root: await sealManifest(manifest, [recipient]),
        chunks: encrypted.chunks,
        ...(options.folderId ? { folderId: options.folderId } : {}),
        ...(options.previousVersionId ? { previousVersionId: options.previousVersionId } : {}),
        ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
        ...(wallet ? { wallet } : {}),
      });
      fileId = declared.object.id;
      jobId = declared.job.id;
    }

    const job =
      options.wait === false
        ? await this.jobs.get(jobId)
        : await this.jobs.waitFor(
            jobId,
            options.onProgress ? { onUpdate: options.onProgress } : {},
          );
    return { file: await this.info(fileId), job };
  }

  /** Downloads and decrypts a file on this device. */
  async get(id: string): Promise<{ data: Uint8Array; name: string; mime: string }> {
    const detail = await this.detail(id);
    if (!detail.spaceId || detail.keyEpoch === null) {
      throw new MemDotError(400, "NOT_A_FILE", "That object is not a file in a space.");
    }
    const identities = this.ctx.vault.ownedIdentities(detail.spaceId, detail.keyEpoch).slice(0, 1);
    return readObject(this.ctx, detail, identities, (segmentId) => this.detail(segmentId));
  }

  async info(id: string): Promise<FileInfo> {
    const detail = await this.detail(id);
    return openFileInfo(detail, await this.identitiesFor(detail));
  }

  detail(id: string): Promise<ObjectDetail> {
    return unwrap(this.ctx.transport.api.GET("/v1/objects/{id}", { params: { path: { id } } }));
  }

  /** Files (and other objects) in a space or folder, names decrypted here. */
  async list(
    query: {
      spaceId?: string;
      folderId?: string | "root";
      kind?: RawObject["kind"] & Schemas["NewObject"]["kind"];
      cursor?: string;
      limit?: number;
    } = {},
  ): Promise<{ items: ListedFile[]; nextCursor: string | null; headBlock: number | null }> {
    const page = await unwrap(
      this.ctx.transport.api.GET("/v1/objects", { params: { query: { kind: "file", ...query } } }),
    );
    return {
      items: await Promise.all(
        page.items.map(async ({ expiresAtBlock, ...raw }) => ({
          ...(await openFileInfo(raw, await this.identitiesFor(raw))),
          expiresAtBlock,
        })),
      ),
      nextCursor: page.nextCursor,
      headBlock: page.headBlock,
    };
  }

  /** Renames by sealing new metadata; the stored bytes are untouched. */
  async rename(id: string, name: string): Promise<FileInfo> {
    const detail = await this.detail(id);
    if (!detail.spaceId) throw new MemDotError(400, "NOT_A_FILE", "That object is not a file.");
    const space = await this.spaces.raw(detail.spaceId);
    const current = await openFileInfo(detail, await this.identitiesFor(detail));
    const meta: FileMeta = {
      name,
      mime: current.mime ?? "application/octet-stream",
      size: current.size ?? 0,
    };
    const sealed = await sealTo(utf8ToBytes(JSON.stringify(meta)), [
      this.ctx.vault.sealTo(space.id, space.keyEpoch),
    ]);
    const raw = await unwrap(
      this.ctx.transport.api.PATCH("/v1/objects/{id}", {
        params: { path: { id } },
        body: { encryptedMeta: toBase64(sealed) },
      }),
    );
    this.epochs.set(space.id, space.keyEpoch);
    return openFileInfo(raw, await this.identitiesFor(raw));
  }

  move(id: string, folderId: string | null) {
    return unwrap(
      this.ctx.transport.api.PATCH("/v1/objects/{id}", {
        params: { path: { id } },
        body: { folderId },
      }),
    );
  }

  /** Tombstones and stops renewing; the bytes expire from the chain within 7 days. */
  delete(id: string) {
    return unwrap(this.ctx.transport.api.DELETE("/v1/objects/{id}", { params: { path: { id } } }));
  }

  async versions(id: string): Promise<FileInfo[]> {
    const { items } = await unwrap(
      this.ctx.transport.api.GET("/v1/objects/{id}/versions", { params: { path: { id } } }),
    );
    return Promise.all(items.map(async (raw) => openFileInfo(raw, await this.identitiesFor(raw))));
  }

  /** "Renew now": every stored blob moves to a fresh 7-day window, same CIDs. */
  async renew(id: string, options: { wait?: boolean } = {}): Promise<Job> {
    const job = await unwrap(
      this.ctx.transport.api.POST("/v1/objects/{id}/renew", { params: { path: { id } } }),
    );
    return options.wait === false ? job : this.jobs.waitFor(job.id);
  }

  /** What storing `bytes` of plaintext costs on V3, before anything is encrypted. */
  estimate(bytes: number): { blobs: number; planck: bigint } {
    if (bytes <= TINY_FILE_BYTES) return { blobs: 1, planck: quoteStoreFee(bytes + 300) };
    const chunkCount = Math.ceil(bytes / 7_000_000);
    let planck = quoteStoreFee(MANIFEST_ESTIMATE_BYTES);
    for (let i = 0; i < chunkCount; i += 1) {
      planck += quoteStoreFee(Math.min(7_000_000, bytes - i * 7_000_000) + 200);
    }
    return { blobs: chunkCount + 1, planck };
  }

  /**
   * Verifies a file over this device's own connection to Portaldot V3, never through MemDot:
   * each blob is fetched by CID and hashed, and its block's TransactionStorage events must hold
   * that content hash at the recorded location.
   */
  async verify(id: string): Promise<VerifyResult> {
    const detail = await this.detail(id);
    const target = detail.segmentId ? await this.detail(detail.segmentId) : detail;
    const chain = await this.ctx.chain();
    const blobs = await Promise.all(
      target.blobs.map(async (blob) => {
        const retrievable = await bitswapGet(chain.client, blob.cid)
          .then(() => true)
          .catch(() => false);
        let onChain = false;
        if (blob.block !== null && blob.indexInBlock !== null) {
          const hash = toHex(contentHashFromCid(blob.cid));
          const events = await withTimeout(
            storageEventsAt(chain, blob.block),
            BITSWAP_TIMEOUT_MS,
          ).catch(() => []);
          onChain = events.some(
            (event) => event.index === blob.indexInBlock && toHex(event.contentHash) === hash,
          );
        }
        return { cid: blob.cid, retrievable, onChain, block: blob.block, index: blob.indexInBlock };
      }),
    );
    return { ok: blobs.every((b) => b.retrievable && b.onChain), blobs };
  }

  /**
   * Every epoch's identity up to the space's current one: a rename after a rotation seals the
   * metadata with the newer epoch. Space epochs are cached per client.
   */
  private async identitiesFor(raw: RawObject): Promise<string[]> {
    if (!this.ctx.vault.unlocked || !raw.spaceId) return [];
    let epoch = this.epochs.get(raw.spaceId);
    if (epoch === undefined) {
      epoch = (await this.spaces.raw(raw.spaceId)).keyEpoch;
      this.epochs.set(raw.spaceId, epoch);
    }
    return this.ctx.vault.ownedIdentities(raw.spaceId, Math.max(epoch, raw.keyEpoch ?? 0));
  }
}

function requireWallet(wallet: Wallet | undefined): Wallet {
  if (!wallet) {
    throw new MemDotError(
      400,
      "WALLET_REQUIRED",
      "This space is self-signed: pass the wallet that signs each store.",
    );
  }
  return wallet;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Rejects when the promise takes longer than `ms` (a node that stops answering). */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
