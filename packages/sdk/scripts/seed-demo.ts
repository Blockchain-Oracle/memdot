// S07: seeds a demo space through the real pipeline, on live Portaldot V3: encrypted on this
// machine, stored by the relayer, renewed, shared, verified, and recorded in MemDotRegistry. The
// transactions it prints become the README's evidence table. Spends about 13 tPOT.
// Usage: API_URL=... WEB_ORIGIN=... pnpm --filter @memdot/sdk seed:demo

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
import { MemDot, walletFromMnemonic } from "../src/index.js";

const baseUrl = process.env.API_URL ?? "http://localhost:8787";
const origin = process.env.WEB_ORIGIN ?? "http://localhost:3100";
const client = () => MemDot.create({ baseUrl, origin, client: "seed-demo" });
const repo = (path: string) => new URL(`../../../${path}`, import.meta.url);

const ownerMnemonic = generateMnemonic(wordlist);
const recipientMnemonic = generateMnemonic(wordlist);
const ownerWallet = walletFromMnemonic(ownerMnemonic);
const recipientWallet = walletFromMnemonic(recipientMnemonic);

const owner = client();
const { recoveryCode } = await owner.account.create(ownerWallet, { name: "MemDot demo" });
const recipient = client();
const recipientAccount = await recipient.account.create(recipientWallet, {
  name: "Demo recipient",
});

// The sign-in material stays outside git: context/ is never published.
await mkdir(repo("context/memdot"), { recursive: true });
await writeFile(
  repo("context/memdot/demo-accounts.local.md"),
  `# Seeded demo accounts (${origin})\n\n- Owner recovery code: ${recoveryCode}\n- Owner wallet: ${ownerMnemonic}\n- Recipient recovery code: ${recipientAccount.recoveryCode}\n- Recipient wallet: ${recipientMnemonic}\n`,
);

const space = await owner.spaces.create({ name: "MemDot demo" });
console.log(`Space ${space.id}`);

const notes = await owner.files.putMany(
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
        JSON.stringify({ agent: "demo", remembers: ["The user prefers short answers."] }, null, 2),
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
const segmentJob = notes[0]?.job;
console.log(`Three small files in one segment: ${segmentJob?.status} #${segmentJob?.block}`);

const banner = await owner.files.put(await readFile(repo("assets/brand/banner.png")), {
  spaceId: space.id,
  name: "banner.png",
  mime: "image/png",
});
console.log(`A larger file, chunk plus sealed manifest: ${banner.job.status} #${banner.job.block}`);

const firstNote = notes[0]?.file;
if (!firstNote) throw new Error("the notes were not stored");
const renewed = await owner.files.renew(firstNote.id);
const renewedJob = await owner.jobs.waitFor(renewed.id);
console.log(`Renewed: ${renewedJob.status} #${renewedJob.block}`);

const grant = await owner.sharing.shareSpace(space.id, { address: recipientWallet.address });
const [received] = (await recipient.sharing.list("received")).items;
if (!received) throw new Error("the recipient sees no grant");
const opened = await recipient.sharing.get(received.id, firstNote.id);
console.log(`Shared and opened by the recipient: ${opened.name}`);

const verifiedNote = await owner.files.verify(firstNote.id);
const verifiedBanner = await owner.files.verify(banner.file.id);
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

const evidence = {
  stage: "S07",
  at: new Date().toISOString(),
  app: origin,
  api: baseUrl,
  registry: REGISTRY_ADDRESS,
  store: {
    segment: {
      cid: firstNote.cid,
      txHash: segmentJob?.txHash,
      block: segmentJob?.block,
      files: notes.length,
    },
    file: { cid: banner.file.cid, txHash: banner.job.txHash, block: banner.job.block },
  },
  renew: { cid: firstNote.cid, txHash: renewedJob.txHash, block: renewedJob.block },
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
