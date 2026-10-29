// Walks S04's "done when" against a running API and worker on live Portaldot V3, doing what a
// client does: wallet sign-in, recovery code, key bundle stored on chain, account setup, a space,
// an API key, then an encrypted upload through the relayer followed over SSE to finalized.
// Spends ~0.4 tPOT. Usage: run the API and worker, then pnpm --filter @memdot/api walk:s04

import { randomBytes } from "node:crypto";
import { cidOf } from "@memdot/chain";
import {
  buildManifest,
  decryptObject,
  encryptObject,
  generateSpaceKey,
  manifestObjectKey,
  openManifest,
  sealManifest,
  sealTo,
  serializeKeyBundle,
  spaceIdentity,
  spaceRecipient,
} from "@memdot/crypto";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { API, b64, Client, check, type Declared, onboard } from "./client.js";

const client = new Client();

// 1–3. Wallet sign-in, recovery code, account setup; then the key bundle is stored as an account
//      object and the account points at it.
const { bundle, owner, encryptionKey } = await onboard(client);
const bundleBytes = serializeKeyBundle(bundle);
const bundleCid = cidOf(bundleBytes);
const keyBundle = await client.upload(
  {
    kind: "key_bundle",
    sizeBytes: bundleBytes.length,
    root: { cid: bundleCid, size: bundleBytes.length },
  },
  new Map([[bundleCid, bundleBytes]]),
  "session",
);
check(
  "key bundle declared and uploaded (account object, no quota)",
  keyBundle.object.cid === bundleCid,
);
const pointed = await client.call<{ keyBundleCid: string }>("PUT", "/v1/account", {
  body: { owner, encryptionKey, keyBundleCid: bundleCid },
});
check("account points at its key bundle", pointed.json.keyBundleCid === bundleCid, pointed.json);

// 4. A sponsored space and a read_write API key.
const spaceKey = generateSpaceKey();
const space = await client.call<{ id: string; quotaBytes: number; usedBytes: number }>(
  "POST",
  "/v1/spaces",
  {
    body: {
      encryptedName: b64(await sealTo(utf8ToBytes("Walk space"), [spaceRecipient(spaceKey)])),
    },
  },
);
check("space created", space.status === 201, space.json);
const key = await client.call<{ key: string; role: string }>("POST", "/v1/keys", {
  body: { name: "S04 walk", role: "read_write" },
});
client.apiKey = key.json.key;
check(
  "API key minted (md_, shown once)",
  key.status === 201 && client.apiKey.startsWith("md_"),
  key.json,
);

// 5. An encrypted file through the relayer, with the API key.
const plaintext = utf8ToBytes(
  `MemDot S04 walk ${new Date().toISOString()} ${bytesToHex(randomBytes(16))}`,
);
const encrypted = await encryptObject(plaintext);
const chunkCids = encrypted.chunks.map((chunk) => cidOf(chunk));
const manifest = buildManifest({
  name: "walk.txt",
  mime: "text/plain",
  size: encrypted.size,
  paddedSize: encrypted.paddedSize,
  objectKey: encrypted.objectKey,
  chunks: encrypted.chunks.map((chunk, i) => ({ cid: chunkCids[i] ?? "", bytes: chunk.length })),
  createdAt: new Date().toISOString(),
});
const manifestBytes = await sealManifest(manifest, [spaceRecipient(spaceKey)]);
const manifestCid = cidOf(manifestBytes);
const blobs = new Map<string, Uint8Array>([
  [manifestCid, manifestBytes],
  ...encrypted.chunks.map((chunk, i) => [chunkCids[i] ?? "", chunk] as [string, Uint8Array]),
]);
const fileBody = {
  kind: "file",
  spaceId: space.json.id,
  encryptedMeta: b64(await sealTo(utf8ToBytes("walk.txt"), [spaceRecipient(spaceKey)])),
  sizeBytes: encrypted.paddedSize,
  root: { cid: manifestCid, size: manifestBytes.length },
  chunks: encrypted.chunks.map((chunk, i) => ({ cid: chunkCids[i], size: chunk.length })),
};
const idempotencyKey = `walk-${bytesToHex(randomBytes(8))}`;
const file = await client.upload(fileBody, blobs, "key", idempotencyKey);
check("file declared with an API key and every blob uploaded", file.job.status !== "failed");

const replay = await client.call<Declared>("POST", "/v1/objects", {
  body: fileBody,
  auth: "key",
  headers: { "idempotency-key": idempotencyKey },
});
check(
  "a repeated Idempotency-Key replays the same object (no second spend)",
  replay.status === 200 && replay.json.object.id === file.object.id,
  replay.json,
);

const tooBig = await client.call<{ error: { code: string } }>("POST", "/v1/objects", {
  auth: "key",
  body: {
    kind: "file",
    spaceId: space.json.id,
    sizeBytes: 1,
    root: { cid: cidOf(randomBytes(64)), size: 64 },
    chunks: Array.from({ length: 2 }, () => ({ cid: cidOf(randomBytes(32)), size: 6_000_000 })),
  },
});
check(
  "a quota breach is refused before any spend",
  tooBig.json.error?.code === "QUOTA_EXCEEDED",
  tooBig.json,
);

console.log(`following key bundle job ${keyBundle.job.id}`);
const bundleJob = await client.followJob(keyBundle.job.id);
check("key bundle finalized on V3", bundleJob.status === "finalized", bundleJob);
console.log(`following file job ${file.job.id}`);
const fileJob = await client.followJob(file.job.id);
check("file finalized on V3 (manifest + chunk)", fileJob.status === "finalized", fileJob);

// 6. Read it back by CID through the gateway and decrypt on the client.
const detail = await client.call<{
  blobs: { cid: string; block: number; indexInBlock: number; txHash: string }[];
}>("GET", `/v1/objects/${file.object.id}`, { auth: "key" });
for (const blob of detail.json.blobs)
  console.log(`  · ${blob.cid} at ${blob.block}/${blob.indexInBlock} (${blob.txHash})`);
const manifestBack = new Uint8Array(
  await (await fetch(`${API}/v1/cids/${manifestCid}`)).arrayBuffer(),
);
const opened = await openManifest(manifestBack, spaceIdentity(spaceKey));
const chunksBack = await Promise.all(
  opened.chunks.map(
    async (chunk) =>
      new Uint8Array(await (await fetch(`${API}/v1/cids/${chunk.cid}`)).arrayBuffer()),
  ),
);
const decrypted = await decryptObject(chunksBack, manifestObjectKey(opened), opened.size);
check(
  "gateway bytes decrypt to the original file",
  Buffer.compare(Buffer.from(decrypted), Buffer.from(plaintext)) === 0,
);
const proofPage = await client.call<{ current: { block: number } | null }>(
  "GET",
  `/v1/proof/cid/${manifestCid}`,
);
check(
  "public proof page shows the manifest's location",
  proofPage.json.current !== null,
  proofPage.json,
);
console.log(`\nobject ${file.object.id}, manifest ${manifestCid}`);
