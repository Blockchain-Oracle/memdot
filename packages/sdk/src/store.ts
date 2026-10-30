import { cidOf, storeChunk } from "@memdot/chain";
import type { Context, Schemas } from "./context.js";
import { MemDotError } from "./errors.js";
import { unwrap } from "./transport.js";
import type { Wallet } from "./wallet.js";

export type StoredObject = Schemas["Object"];
export type DeclaredObject = Schemas["DeclaredObject"];

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
    await storeWithWallet(ctx, declared, blobs, input.wallet, input.onBlob);
    return declared;
  }
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
  for (const slot of declared.uploads) {
    if (recorded.has(slot.cid)) continue;
    const bytes = blobs.get(slot.cid);
    if (!bytes) throw new Error(`no bytes for ${slot.cid}`);
    const stored = await storeChunk(chain.api, wallet.txCreator, bytes);
    await ctx.transport.json("POST", `${slot.url}/stored`, {
      block: stored.location.block,
      indexInBlock: stored.location.index,
    });
    done += 1;
    onBlob?.(done, declared.uploads.length);
  }
}
