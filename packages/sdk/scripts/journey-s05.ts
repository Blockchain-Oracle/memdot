// S05 "done when", through the SDK only, against a running API and worker on live Portaldot V3:
// Dana's file journey, a pending share that completes when Ana signs up, Ana opening the file,
// and a revoke after which Ana cannot read the next version. Spends ~0.5 tPOT.
// Usage: run the API and worker, then pnpm --filter @memdot/sdk journey

import { writeFile } from "node:fs/promises";
import { openManifest, WrongKeyError } from "@memdot/crypto";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { type Job, MemDot, MemDotError, walletFromMnemonic } from "../src/index.js";
import { keyringIdentities } from "../src/vault.js";

const baseUrl = process.env.API_URL ?? "http://localhost:8787";
const origin = process.env.WEB_ORIGIN ?? "http://localhost:3000";
const client = () => MemDot.create({ baseUrl, origin, client: "journey-s05" });

const evidence: Record<string, unknown>[] = [];
function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(
    `${ok ? "✓" : "✗"} ${label}${ok || detail === undefined ? "" : ` → ${JSON.stringify(detail)}`}`,
  );
  if (!ok) process.exitCode = 1;
}
const progress = (job: Job) =>
  console.log(
    `  · ${job.status}${job.progress ? ` ${job.progress.done}/${job.progress.total}` : ""}`,
  );
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

// ── Dana: an app developer ───────────────────────────────────────────────────────────────────
const dana = client();
const danaWallet = walletFromMnemonic(generateMnemonic(wordlist));
const { recoveryCode } = await dana.account.create(danaWallet, { name: "Dana" });
check(
  "Dana creates an account (master key and recovery code made on her device)",
  dana.account.unlocked,
);

const space = await dana.spaces.create({ name: "Client files" });
check("Dana creates a space; its name is sealed with the space key", space.name === "Client files");

const key = await dana.keys.create({ name: "dana-server", role: "read_write" });
const server = client();
server.useApiKey(key.key);
await server.account.unlockWithRecoveryCode(recoveryCode);
check("her server unlocks with an API key and the recovery code", server.account.unlocked);

const v1Text = `Invoice #1042 for Ana — ${new Date().toISOString()}`;
const v1 = await server.files.put(utf8ToBytes(v1Text), {
  spaceId: space.id,
  name: "invoice-1042.txt",
  mime: "text/plain",
  onProgress: progress,
});
evidence.push({ step: "v1 stored", job: v1.job });
check(
  "the server stores an encrypted file through the relayer, finalized",
  v1.job.status === "finalized",
);
check(
  "its name decrypts on Dana's device",
  (await dana.files.info(v1.file.id)).name === "invoice-1042.txt",
);

const verified = await dana.files.verify(v1.file.id);
evidence.push({ step: "v1 verified", verified });
check(
  "Dana verifies it over her own V3 connection (bytes hash to the CID, event on chain)",
  verified.ok,
  verified,
);

// ── Sharing with Ana before she has an account ──────────────────────────────────────────────
const anaWallet = walletFromMnemonic(generateMnemonic(wordlist));
const pending = await dana.sharing.shareSpace(space.id, { address: anaWallet.address });
check(
  "sharing with Ana, who has no MemDot yet, waits as pending",
  pending.status === "pending",
  pending,
);

const ana = client();
await ana.account.create(anaWallet, { name: "Ana" });
check("Ana creates her account; her sharing key is registered", ana.account.unlocked);

dana.account.lock();
await dana.account.unlockWithRecoveryCode(recoveryCode);
const [completed] = (await dana.sharing.list("given", space.id)).items;
check(
  "Dana's next unlock wraps the keyring to Ana and completes the grant",
  completed?.status === "active" && completed.keyEpoch === 0,
  completed,
);

const [received] = (await ana.sharing.list("received")).items;
if (!received) throw new Error("Ana sees no grant");
const shared = await ana.sharing.files(received.id);
check(
  "Ana lists the shared space and reads the file name",
  shared.items.some((f) => f.name === "invoice-1042.txt"),
  shared.items,
);
const opened = await ana.sharing.get(received.id, v1.file.id);
check("Ana opens the shared file on her device", text(opened.data) === v1Text);

// ── Revoke, then a new version ──────────────────────────────────────────────────────────────
const revoked = await dana.sharing.revoke(received.id);
check("Dana revokes; the space moves to key epoch 1", revoked.spaceKeyEpoch === 1, revoked);

const v2Text = `Invoice #1042 (corrected) — ${new Date().toISOString()}`;
const v2 = await dana.files.put(utf8ToBytes(v2Text), {
  spaceId: space.id,
  name: "invoice-1042.txt",
  mime: "text/plain",
  previousVersionId: v1.file.id,
  onProgress: progress,
});
evidence.push({ step: "v2 stored", job: v2.job });
check("Dana stores the next version, sealed with epoch 1", v2.file.keyEpoch === 1, v2.file);

const refused = await ana.sharing.files(received.id).catch((error: unknown) => error);
check(
  "the API refuses Ana's revoked grant",
  refused instanceof MemDotError && refused.code === "GRANT_REVOKED",
  refused instanceof MemDotError ? refused.code : refused,
);
const keys = await ana.sharing.open(received.id); // still in Ana's memory from before the revoke
const v2Manifest = await ana.files.detail(v2.file.id).catch(() => null);
check("Ana cannot even list Dana's new version through the API", v2Manifest === null);
const sealed = new Uint8Array(
  await (await fetch(`${baseUrl}/v1/cids/${v2.file.cid}`)).arrayBuffer(),
);
const cannotOpen = await openManifest(
  sealed,
  keys.kind === "space" ? keyringIdentities(keys.keys) : [],
).then(
  () => false,
  (error: unknown) => error instanceof WrongKeyError,
);
check("and the keys she kept cannot open it: the bytes are public, the key is not", cannotOpen);

const versions = await dana.files.versions(v2.file.id);
check(
  "Dana sees both versions",
  versions.length === 2,
  versions.map((v) => v.id),
);
check("Dana reads v2", text((await dana.files.get(v2.file.id)).data) === v2Text);
check("and still reads v1 (epoch 0)", text((await dana.files.get(v1.file.id)).data) === v1Text);

// ── A new device: recover with the code ─────────────────────────────────────────────────────
const laptop = client();
await laptop.account.recover(recoveryCode);
check(
  "on a new device, the recovery code signs in, unlocks and opens the same file",
  text((await laptop.files.get(v2.file.id)).data) === v2Text,
);

const usage = await dana.usage();
evidence.push({ step: "usage", usage });
console.log(
  `\nspace ${space.id}; ${usage.blobs.stored} blobs stored, ${usage.spentPlanck} planck spent`,
);
await writeFile(
  new URL(
    `../../../docs/evidence/s05-journey-${new Date().toISOString().slice(0, 10)}.json`,
    import.meta.url,
  ),
  `${JSON.stringify({ stage: "S05", spaceId: space.id, evidence }, null, 2)}\n`,
);
await Promise.all([dana.close(), server.close(), ana.close(), laptop.close()]);
