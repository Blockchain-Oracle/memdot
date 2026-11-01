// S07: walks a self-signed space on live Portaldot V3. The wallet signs each top-level `store` and
// pays for it; MemDot only records what the chain shows. Run it while the chain-tx queue is idle:
// it tops the wallet up from the relayer, and the relayer has one nonce line.
// Spends about 8 tPOT. Usage: API_URL=... WEB_ORIGIN=... pnpm --filter @memdot/sdk seed:self-signed

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createChainClient, formatTpot, signerFromMnemonic, transfer } from "@memdot/chain";
import { TINY_FILE_BYTES, TPOT_DECIMALS } from "@memdot/config";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { MemDot, walletFromMnemonic } from "../src/index.js";

const VERIFY_ATTEMPTS = 3;
const PLANCK_PER_TPOT = 10n ** BigInt(TPOT_DECIMALS);
const WALLET_FLOOR = 8n * PLANCK_PER_TPOT;
const WALLET_TOP_UP = 10n * PLANCK_PER_TPOT;
const SPACE_NAME = "Self-signed demo";

const baseUrl = process.env.API_URL ?? "http://localhost:8787";
const origin = process.env.WEB_ORIGIN ?? "http://localhost:3100";
const repo = (path: string) => new URL(`../../../${path}`, import.meta.url);

// The sign-in material stays outside git: context/ is never published.
const accounts = JSON.parse(
  await readFile(repo("context/memdot/demo-accounts.local.json"), "utf8"),
) as { ownerRecoveryCode: string; ownerMnemonic: string };
if (existsSync(repo(".env"))) process.loadEnvFile(repo(".env"));
const relayerMnemonic = process.env.SIGNER_MNEMONIC;
if (!relayerMnemonic) throw new Error("SIGNER_MNEMONIC is not set in .env");

const wallet = walletFromMnemonic(accounts.ownerMnemonic);
const chain = createChainClient(process.env.PORTALDOT_WSS);
const free = async () => (await chain.api.query.System.Account.getValue(wallet.address)).data.free;

if ((await free()) < WALLET_FLOOR) {
  const relayer = signerFromMnemonic(relayerMnemonic);
  await transfer(chain.api, relayer.txCreator, wallet.publicKey, WALLET_TOP_UP);
}
const before = await free();
console.log(`Wallet ${wallet.address} holds ${formatTpot(before)}`);

const owner = MemDot.create({ baseUrl, origin, client: "self-signed-demo" });
await owner.account.signInWithRecoveryCode(accounts.ownerRecoveryCode);
await owner.account.unlockWithRecoveryCode(accounts.ownerRecoveryCode);

const space =
  (await owner.spaces.list()).find((candidate) => candidate.name === SPACE_NAME) ??
  (await owner.spaces.create({ name: SPACE_NAME, mode: "self_signed" }));
console.log(`Space ${space.id} (${space.mode})`);

const stored = (await owner.files.list({ spaceId: space.id })).items;
const small =
  stored.find((file) => file.name === "signed-by-my-wallet.md") ??
  (
    await owner.files.put(
      utf8ToBytes(
        "# Signed by my wallet\n\nThis note was encrypted on my device. My wallet signed the store and paid for it; MemDot's relayer did not.\n",
      ),
      { spaceId: space.id, name: "signed-by-my-wallet.md", mime: "text/markdown", wallet },
    )
  ).file;
console.log(`Small file: ${small.id}`);

// Just over the segment limit, so this one is a chunk plus a sealed manifest: two signatures.
const large =
  stored.find((file) => file.name === "large-note.bin") ??
  (
    await owner.files.put(randomBytes(TINY_FILE_BYTES + 1), {
      spaceId: space.id,
      name: "large-note.bin",
      mime: "application/octet-stream",
      wallet,
    })
  ).file;
console.log(`Larger file: ${large.cid}`);

const after = await free();
console.log(`The wallet paid ${formatTpot(before - after)} in this run.`);

// A node can stall on a read; "inconclusive" means ask again, anything else is a real answer.
const verifyPatiently = async (id: string) => {
  for (let attempt = 1; ; attempt += 1) {
    const result = await owner.files.verify(id);
    if (result.ok) return result;
    if (!result.inconclusive || attempt >= VERIFY_ATTEMPTS) {
      throw new Error(`verification failed: ${JSON.stringify(result)}`);
    }
  }
};
const verifiedSmall = await verifyPatiently(small.id);
const verifiedLarge = await verifyPatiently(large.id);
console.log("Verified over this machine's own V3 connection.");

const firstStoreOf = async (cid: string) => {
  const proof = await owner.proof.cid(cid);
  return { cid, txHash: proof.firstStore?.txHash, block: proof.firstStore?.block };
};
const smallCid = verifiedSmall.blobs[0]?.cid;
const largeCid = large.cid;
if (!smallCid || !largeCid) throw new Error("no CID to report");

const evidence = {
  stage: "S07",
  at: new Date().toISOString(),
  app: origin,
  api: baseUrl,
  spaceId: space.id,
  wallet: wallet.address,
  small: await firstStoreOf(smallCid),
  large: await firstStoreOf(largeCid),
  verified: { small: verifiedSmall.blobs, large: verifiedLarge.blobs },
};
await writeFile(
  repo(`docs/evidence/s07-self-signed-${evidence.at.slice(0, 10)}.json`),
  `${JSON.stringify(evidence, null, 2)}\n`,
);
console.log("Evidence written to docs/evidence.");
await owner.close();
chain.destroy();
