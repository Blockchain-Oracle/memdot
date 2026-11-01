// S07: seeds a demo space through the real pipeline, on live Portaldot V3: encrypted on this
// machine, stored by the relayer, renewed, shared, verified, and recorded in MemDotRegistry. The
// transactions it prints become the README's evidence table. Spends about 13 tPOT.
// Usage: API_URL=... WEB_ORIGIN=... pnpm --filter @memdot/sdk seed:demo

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  EVM_CHAIN_ID,
  PORTALDOT_EVM_RPC,
  REGISTRY_ADDRESS,
  REGISTRY_DEPLOY_BLOCK,
} from "@memdot/config";
import { actionName, memDotRegistryAbi } from "@memdot/contracts";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { createPublicClient, defineChain, http } from "viem";
import { MemDot, MemDotError, walletFromMnemonic } from "../src/index.js";

const baseUrl = process.env.API_URL ?? "http://localhost:8787";
const origin = process.env.WEB_ORIGIN ?? "http://localhost:3100";
const client = () => MemDot.create({ baseUrl, origin, client: "seed-demo" });
const repo = (path: string) => new URL(`../../../${path}`, import.meta.url);

interface DemoAccounts {
  ownerRecoveryCode: string;
  ownerMnemonic: string;
  recipientRecoveryCode: string;
  recipientMnemonic: string;
}

// The sign-in material stays outside git: context/ is never published.
const accountsFile = repo("context/memdot/demo-accounts.local.json");
const owner = client();
const recipient = client();
let accounts: DemoAccounts;
if (existsSync(accountsFile)) {
  accounts = JSON.parse(await readFile(accountsFile, "utf8")) as DemoAccounts;
  await owner.account.signInWithRecoveryCode(accounts.ownerRecoveryCode);
  await owner.account.unlockWithRecoveryCode(accounts.ownerRecoveryCode);
  await recipient.account.signInWithRecoveryCode(accounts.recipientRecoveryCode);
  await recipient.account.unlockWithRecoveryCode(accounts.recipientRecoveryCode);
} else {
  const ownerMnemonic = generateMnemonic(wordlist);
  const recipientMnemonic = generateMnemonic(wordlist);
  const created = await owner.account.create(walletFromMnemonic(ownerMnemonic), {
    name: "MemDot demo",
  });
  const recipientCreated = await recipient.account.create(walletFromMnemonic(recipientMnemonic), {
    name: "Demo recipient",
  });
  accounts = {
    ownerRecoveryCode: created.recoveryCode,
    ownerMnemonic,
    recipientRecoveryCode: recipientCreated.recoveryCode,
    recipientMnemonic,
  };
  await mkdir(repo("context/memdot"), { recursive: true });
  await writeFile(accountsFile, `${JSON.stringify(accounts, null, 2)}\n`);
}
const recipientAddress = walletFromMnemonic(accounts.recipientMnemonic).address;

const space =
  (await owner.spaces.list()).find((candidate) => candidate.name === "MemDot demo") ??
  (await owner.spaces.create({ name: "MemDot demo" }));
console.log(`Space ${space.id}`);

// A re-run keeps what is already stored: only the steps still due happen.
const stored = (await owner.files.list({ spaceId: space.id })).items;
const storedNote = stored.find((file) => file.name === "welcome.md");
const notes = storedNote
  ? null
  : await owner.files.putMany(
      [
        {
          name: "welcome.md",
          mime: "text/markdown",
          data: utf8ToBytes(
            "# Welcome to MemDot\n\nThis note was encrypted on the device that wrote it. Portaldot V3 holds only ciphertext, and MemDot's keeper renews it before the 7-day window ends.\n",
          ),
        },
        {
          name: "agent-memory.json",
          mime: "application/json",
          data: utf8ToBytes(
            JSON.stringify(
              { agent: "demo", remembers: ["The user prefers short answers."] },
              null,
              2,
            ),
          ),
        },
        {
          name: "mark.svg",
          mime: "image/svg+xml",
          data: await readFile(repo("assets/brand/mark.svg")),
        },
      ],
      { spaceId: space.id },
    );
if (notes) console.log(`Three small files in one segment: #${notes[0]?.job.block}`);

const storedBanner = stored.find((file) => file.name === "banner.png");
const banner =
  storedBanner ??
  (
    await owner.files.put(await readFile(repo("assets/brand/banner.png")), {
      spaceId: space.id,
      name: "banner.png",
      mime: "image/png",
    })
  ).file;
console.log(`A larger file, chunk plus sealed manifest: ${banner.cid}`);

const firstNote = storedNote ?? notes?.[0]?.file;
if (!firstNote) throw new Error("the notes were not stored");

// The API refuses to pay for a renewal within an hour of the last store; re-run after that.
const renewedJob = await owner.files.renew(firstNote.id).catch((error: unknown) => {
  if (error instanceof MemDotError && error.code === "NOTHING_DUE") return null;
  throw error;
});
console.log(renewedJob ? `Renewed: #${renewedJob.block}` : "Renewal not due yet; re-run later.");

const given = (await owner.sharing.list("given", space.id)).items;
const grant =
  given.find((item) => item.status === "active") ??
  (await owner.sharing.shareSpace(space.id, { address: recipientAddress }));
const [received] = (await recipient.sharing.list("received")).items;
if (!received) throw new Error("the recipient sees no grant");
const opened = await recipient.sharing.get(received.id, firstNote.id);
console.log(`Shared and opened by the recipient: ${opened.name}`);

const verifiedNote = await owner.files.verify(firstNote.id);
const verifiedBanner = await owner.files.verify(banner.id);
if (!verifiedNote.ok || !verifiedBanner.ok) throw new Error("verification failed");
console.log("Verified over this machine's own V3 connection.");

// Records land after the stores they follow, so wait for them to reach the chain.
const rpc = createPublicClient({
  chain: defineChain({
    id: EVM_CHAIN_ID,
    name: "Portaldot V3",
    nativeCurrency: { name: "tPOT", symbol: "tPOT", decimals: 18 },
    rpcUrls: { default: { http: [PORTALDOT_EVM_RPC] } },
  }),
  transport: http(PORTALDOT_EVM_RPC),
});
const ownerRecords = async () =>
  rpc.getContractEvents({
    address: REGISTRY_ADDRESS,
    abi: memDotRegistryAbi,
    eventName: "Recorded",
    fromBlock: BigInt(REGISTRY_DEPLOY_BLOCK),
    toBlock: "latest",
  });
const EXPECTED_RECORDS = 4;
const RECORD_POLL_MS = 6_000;
const RECORD_POLLS = 30;
const spaceIdOnChain = (await owner.spaces.raw(space.id)).chainSpaceId;
let records = await ownerRecords();
for (let poll = 0; poll < RECORD_POLLS; poll += 1) {
  if (records.filter((log) => log.args.spaceId === spaceIdOnChain).length >= EXPECTED_RECORDS)
    break;
  await new Promise((resolve) => setTimeout(resolve, RECORD_POLL_MS));
  records = await ownerRecords();
}
const ours = records.filter((log) => log.args.spaceId === spaceIdOnChain);

const segmentCid = verifiedNote.blobs[0]?.cid;
const bannerCid = banner.cid;
if (!segmentCid || !bannerCid) throw new Error("no CID to report");
const firstStoreOf = async (cid: string) => {
  const proof = await owner.proof.cid(cid);
  return { cid, txHash: proof.firstStore?.txHash, block: proof.firstStore?.block };
};

const evidence = {
  stage: "S07",
  at: new Date().toISOString(),
  app: origin,
  api: baseUrl,
  registry: REGISTRY_ADDRESS,
  segment: { ...(await firstStoreOf(segmentCid)), files: 3 },
  file: await firstStoreOf(bannerCid),
  renew: renewedJob
    ? { cid: segmentCid, txHash: renewedJob.txHash, block: renewedJob.block }
    : null,
  grant: { id: grant.id, status: grant.status },
  verified: { segment: verifiedNote.blobs, file: verifiedBanner.blobs },
  records: ours.map((log) => ({
    action: actionName(log.args.action ?? -1),
    block: Number(log.blockNumber),
    txHash: log.transactionHash,
  })),
};
await writeFile(
  repo(`docs/evidence/s07-seed-${evidence.at.slice(0, 10)}.json`),
  `${JSON.stringify(evidence, null, 2)}\n`,
);
console.log(`${ours.length} registry records. Evidence written to docs/evidence.`);
await Promise.all([owner.close(), recipient.close()]);
