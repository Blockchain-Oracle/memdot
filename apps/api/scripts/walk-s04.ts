// Walks S04's "done when" against a running API and worker on live Portaldot V3, doing what a
// client does: wallet sign-in, recovery code, key bundle stored on chain, account setup, a space,
// an API key, then an encrypted upload through the relayer followed over SSE to finalized.
// Spends ~0.4 tPOT. Usage: run the API and worker, then pnpm --filter @memdot/api walk:s04

import { randomBytes } from "node:crypto";
import { cidOf } from "@memdot/chain";
import {
  addWrap,
  ageRecipient,
  buildManifest,
  createKeyBundle,
  decryptObject,
  encryptObject,
  generateRecoveryCode,
  generateSpaceKey,
  manifestObjectKey,
  openManifest,
  recoverySecret,
  recoverySignInKey,
  sealManifest,
  sealTo,
  serializeKeyBundle,
  spaceIdentity,
  spaceRecipient,
  userKeyPair,
} from "@memdot/crypto";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { SiwsMessage } from "@talismn/siws";
import { AccountId } from "polkadot-api";
import { ownerProofMessage } from "../src/routes/account.js";

const API = process.env.API_URL ?? "http://localhost:8787";
const ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:3000";
const FINALIZE_TIMEOUT_MS = 4 * 60_000;

const hex = (bytes: Uint8Array) => `0x${bytesToHex(bytes)}`;
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(
    `${ok ? "✓" : "✗"} ${label}${ok || detail === undefined ? "" : ` → ${JSON.stringify(detail)}`}`,
  );
  if (!ok) process.exitCode = 1;
}

let cookie = "";
let apiKey = "";

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  options: {
    body?: unknown;
    raw?: Uint8Array;
    headers?: Record<string, string>;
    auth?: "session" | "key";
  } = {},
): Promise<{ status: number; json: T; headers: Headers }> {
  const headers: Record<string, string> = { origin: ORIGIN, ...options.headers };
  if (options.auth === "key") headers.authorization = `Bearer ${apiKey}`;
  else if (cookie) headers.cookie = cookie;
  let body: string | Uint8Array<ArrayBuffer> | undefined;
  if (options.raw) {
    headers["content-type"] = "application/octet-stream";
    body = options.raw as Uint8Array<ArrayBuffer>;
  } else if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }
  const response = await fetch(`${API}${path}`, { method, headers, body });
  const setCookie = response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  if (setCookie) cookie = setCookie;
  const text = await response.text();
  return {
    status: response.status,
    json: (text ? JSON.parse(text) : {}) as T,
    headers: response.headers,
  };
}

interface Declared {
  object: { id: string; cid: string; status: string };
  job: { id: string; status: string };
  uploads: { role: string; index: number; url: string; cid: string }[];
}

/** Declares an object and uploads every blob, the way the SDK will. */
async function upload(
  body: Record<string, unknown>,
  blobs: Map<string, Uint8Array>,
  auth: "session" | "key",
  idempotencyKey?: string,
) {
  const declared = await call<Declared>("POST", "/v1/objects", {
    body,
    auth,
    ...(idempotencyKey ? { headers: { "idempotency-key": idempotencyKey } } : {}),
  });
  if (declared.status !== 202) throw new Error(`declare failed: ${JSON.stringify(declared.json)}`);
  for (const slot of declared.json.uploads) {
    const bytes = blobs.get(slot.cid);
    if (!bytes) throw new Error(`no bytes for ${slot.cid}`);
    const put = await call("PUT", slot.url, { raw: bytes, auth });
    if (put.status !== 200) throw new Error(`upload failed: ${JSON.stringify(put.json)}`);
  }
  return declared.json;
}

/** Follows the job's SSE stream until it is finalized or failed. */
async function followJob(jobId: string): Promise<{ status: string; seen: string[] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FINALIZE_TIMEOUT_MS);
  const seen: string[] = [];
  try {
    const response = await fetch(`${API}/v1/jobs/${jobId}/events`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: "text/event-stream" },
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("no event stream");
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (const line of buffer.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const event = JSON.parse(line.slice(6)) as {
          status: string;
          progress?: { done: number; total: number };
        };
        const label = `${event.status}${event.progress ? ` ${event.progress.done}/${event.progress.total}` : ""}`;
        if (seen.at(-1) !== label) {
          seen.push(label);
          console.log(`  · ${label}`);
        }
        if (event.status === "finalized" || event.status === "failed")
          return { status: event.status, seen };
      }
      buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
    }
    return { status: "closed", seen };
  } finally {
    clearTimeout(timer);
  }
}

// 1. Wallet sign-in (SIWS), as Talisman signs it.
const wallet = sr25519CreateDerive(randomBytes(32))("");
const address = AccountId(42).dec(wallet.publicKey);
const { json: nonce } = await call<{ nonce: string }>("POST", "/api/auth/siws/nonce", { body: {} });
const origin = new URL(ORIGIN);
const message = new SiwsMessage({
  domain: origin.host,
  uri: origin.origin,
  address,
  nonce: nonce.nonce,
  statement: "Sign in to MemDot",
  chainName: "Portaldot",
  issuedAt: Date.now(),
}).prepareMessage();
const signedIn = await call("POST", "/api/auth/siws/verify", {
  body: { message, signature: hex(wallet.sign(utf8ToBytes(`<Bytes>${message}</Bytes>`))) },
});
check("wallet sign-in", signedIn.status === 200, signedIn.json);

// 2. Master key, recovery code (mandatory), key bundle.
const code = generateRecoveryCode();
const { accountMasterKey, bundle } = createKeyBundle();
const withRecovery = addWrap(
  bundle,
  accountMasterKey,
  { kind: "recovery", id: "recovery" },
  recoverySecret(code),
);
const recovery = await call("POST", "/api/auth/recovery/register", {
  body: { publicKey: hex(recoverySignInKey(code).publicKey) },
});
check("recovery code registered", recovery.status === 200, recovery.json);

// 3. Account setup: the wallet proves it owns the chain account; then the key bundle is stored
//    as an account object and the account points at it.
const meBefore = await call<{ user: { id: string } }>("GET", "/v1/account");
const ownerHex = hex(wallet.publicKey);
const proof = wallet.sign(
  utf8ToBytes(`<Bytes>${ownerProofMessage(meBefore.json.user.id, ownerHex)}</Bytes>`),
);
const encryptionKey = ageRecipient(userKeyPair(accountMasterKey).publicKey);
const owner = { kind: "substrate", account: ownerHex, signature: hex(proof) };
const setup = await call("PUT", "/v1/account", { body: { owner, encryptionKey } });
check("account set up with owner proof", setup.status === 200, setup.json);

const bundleBytes = serializeKeyBundle(withRecovery);
const bundleCid = cidOf(bundleBytes);
const keyBundle = await upload(
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
const pointed = await call<{ keyBundleCid: string }>("PUT", "/v1/account", {
  body: { owner, encryptionKey, keyBundleCid: bundleCid },
});
check("account points at its key bundle", pointed.json.keyBundleCid === bundleCid, pointed.json);

// 4. A sponsored space and a read_write API key.
const spaceKey = generateSpaceKey();
const space = await call<{ id: string; quotaBytes: number; usedBytes: number }>(
  "POST",
  "/v1/spaces",
  {
    body: {
      encryptedName: b64(await sealTo(utf8ToBytes("Walk space"), [spaceRecipient(spaceKey)])),
    },
  },
);
check("space created", space.status === 201, space.json);
const key = await call<{ key: string; role: string }>("POST", "/v1/keys", {
  body: { name: "S04 walk", role: "read_write" },
});
apiKey = key.json.key;
check("API key minted (md_, shown once)", key.status === 201 && apiKey.startsWith("md_"), key.json);

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
const file = await upload(fileBody, blobs, "key", idempotencyKey);
check("file declared with an API key and every blob uploaded", file.job.status !== "failed");

const replay = await call<Declared>("POST", "/v1/objects", {
  body: fileBody,
  auth: "key",
  headers: { "idempotency-key": idempotencyKey },
});
check(
  "a repeated Idempotency-Key replays the same object (no second spend)",
  replay.status === 200 && replay.json.object.id === file.object.id,
  replay.json,
);

const tooBig = await call<{ error: { code: string } }>("POST", "/v1/objects", {
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
const bundleJob = await followJob(keyBundle.job.id);
check("key bundle finalized on V3", bundleJob.status === "finalized", bundleJob);
console.log(`following file job ${file.job.id}`);
const fileJob = await followJob(file.job.id);
check("file finalized on V3 (manifest + chunk)", fileJob.status === "finalized", fileJob);

// 6. Read it back by CID through the gateway and decrypt on the client.
const detail = await call<{
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
const proofPage = await call<{ current: { block: number } | null }>(
  "GET",
  `/v1/proof/cid/${manifestCid}`,
);
check(
  "public proof page shows the manifest's location",
  proofPage.json.current !== null,
  proofPage.json,
);
console.log(`\nobject ${file.object.id}, manifest ${manifestCid}`);
