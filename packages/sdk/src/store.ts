import { cidOf, storeChunk } from "@memdot/chain";
import { BLOCK_MS } from "@memdot/config";
import type { Context, Schemas } from "./context.js";
import { MemDotError } from "./errors.js";
import { unwrap } from "./transport.js";
import type { Wallet } from "./wallet.js";

export type StoredObject = Schemas["Object"];
export type DeclaredObject = Schemas["DeclaredObject"];

/** The API can see a finalized block a moment after the wallet does; retry for a few blocks. */
const RECORD_ATTEMPTS = 5;

export interface StoreInput {
  kind: StoredObject["kind"] & Schemas["NewObject"]["kind"];
  spaceId?: string;
  folderId?: string;
  keyEpoch?: number;
  encryptedMeta?: Uint8Array;
  /** Padded plaintext size, reported for usage (the real size lives in the sealed manifest). */
  sizeBytes: number;
  /** The manifest, segment, keyring or bundle that names the rest. */
  root: Uint8Array;
  chunks?: Uint8Array[];
  previousVersionId?: string;
  /** Makes a retried call safe; one is generated if omitted. */
  idempotencyKey?: string;
  /** Self-signed spaces: the wallet that signs each `store`. */
  wallet?: Wallet;
  onBlob?: (done: number, total: number) => void;
}

const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

/**
 * Declares an object (CIDs computed here), then gets every blob onto the chain: uploaded to
 * MemDot's relayer, or, in a self-signed space, stored by the wallet and recorded. Self-signed
 * uploads resume: blobs already recorded are skipped.
 */
export async function storeObject(ctx: Context, input: StoreInput): Promise<DeclaredObject> {
  const blobs = new Map<string, Uint8Array>();
  const root = { cid: cidOf(input.root), size: input.root.length };
  blobs.set(root.cid, input.root);
  const chunks = (input.chunks ?? []).map((chunk) => {
    const cid = cidOf(chunk);
    blobs.set(cid, chunk);
    return { cid, size: chunk.length };
  });

  const declared = await unwrap(
    ctx.transport.api.POST("/v1/objects", {
      headers: ctx.transport.idempotencyHeader(input.idempotencyKey ?? crypto.randomUUID()),
      body: {
        kind: input.kind,
        sizeBytes: input.sizeBytes,
        root,
        chunks,
        ...(input.spaceId ? { spaceId: input.spaceId } : {}),
        ...(input.folderId ? { folderId: input.folderId } : {}),
        ...(input.keyEpoch !== undefined ? { keyEpoch: input.keyEpoch } : {}),
        ...(input.encryptedMeta ? { encryptedMeta: toBase64(input.encryptedMeta) } : {}),
        ...(input.previousVersionId ? { previousVersionId: input.previousVersionId } : {}),
      },
    }),
  );

  if (input.wallet) {
    await storeWithWallet(ctx, declared, blobs, input.wallet, input.onBlob).catch(
      async (error: unknown) => {
        // With a key the caller can retry and resume. Without one nothing can, so let go of it.
        if (!input.idempotencyKey) {
          await ctx.transport.api.DELETE("/v1/objects/{id}", {
            params: { path: { id: declared.object.id } },
          });
        }
        throw error;
      },
    );
  } else {
    let done = 0;
    for (const slot of declared.uploads) {
      const bytes = blobs.get(slot.cid);
      if (!bytes) throw new Error(`no bytes for ${slot.cid}`);
      await ctx.transport.send("PUT", slot.url, {
        body: bytes as Uint8Array<ArrayBuffer>,
        headers: { "content-type": "application/octet-stream" },
      });
      done += 1;
      input.onBlob?.(done, declared.uploads.length);
    }
  }
  // A key bundle is recorded by the account's RegisterKey record instead.
  if (input.kind !== "key_bundle") {
    await ctx.registry.addObject({
      kind: input.kind,
      rootCid: root.cid,
      size: root.size,
      ...(input.spaceId ? { spaceId: input.spaceId } : {}),
    });
  }
  return declared;
}

/**
 * Self-signed: the wallet signs each blob's top-level `store` (never wrapped, as V3 requires),
 * and the API records it after checking the finalized block. Blobs already recorded are skipped,
 * so a closed tab resumes where it stopped.
 */
async function storeWithWallet(
  ctx: Context,
  declared: DeclaredObject,
  blobs: Map<string, Uint8Array>,
  wallet: Wallet,
  onBlob?: (done: number, total: number) => void,
): Promise<void> {
  if (!wallet.txCreator) {
    throw new MemDotError(400, "WALLET_CANNOT_SIGN", "This wallet cannot sign transactions.");
  }
  const chain = await ctx.chain();
  const detail = await unwrap(
    ctx.transport.api.GET("/v1/objects/{id}", { params: { path: { id: declared.object.id } } }),
  );
  const recorded = new Set(detail.blobs.filter((b) => b.status !== "pending").map((b) => b.cid));
  let done = recorded.size;
  onBlob?.(done, declared.uploads.length);
  for (const slot of declared.uploads) {
    if (recorded.has(slot.cid)) continue;
    const bytes = blobs.get(slot.cid);
    if (!bytes) throw new Error(`no bytes for ${slot.cid}`);
    const stored = await storeChunk(chain.api, wallet.txCreator, bytes).catch(walletFailure);
    await recordStored(ctx, slot.url, stored.location);
    done += 1;
    onBlob?.(done, declared.uploads.length);
  }
}

/** Tells the API where the wallet's store landed. The wallet has already paid, so be patient. */
async function recordStored(
  ctx: Context,
  url: string,
  location: { block: number; index: number },
): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await ctx.transport.json("POST", `${url}/stored`, {
        block: location.block,
        indexInBlock: location.index,
      });
      return;
    } catch (error) {
      const early = error instanceof MemDotError && error.code === "NOT_FINALIZED";
      if (!early || attempt >= RECORD_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, BLOCK_MS));
    }
  }
}

function walletFailure(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (/cancel|reject|denied/i.test(message)) {
    throw new MemDotError(
      400,
      "WALLET_CANCELLED",
      "The wallet request was cancelled.",
      null,
      error,
    );
  }
  if (/payment|insufficient|inability/i.test(message)) {
    throw new MemDotError(
      402,
      "WALLET_NO_FUNDS",
      "This wallet doesn't hold enough tPOT to pay for the store.",
      null,
      error,
    );
  }
  throw error;
}
