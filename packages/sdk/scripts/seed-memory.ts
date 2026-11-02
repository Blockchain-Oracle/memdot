// S08: the demo account's memories, written through the real pipeline, for the README's proof table
// and for anyone opening the demo. Resumable: what's already there is left alone. Spends about 1 tPOT.
// Usage: API_URL=… WEB_ORIGIN=… pnpm --filter @memdot/sdk seed:memory

import { readFile, writeFile } from "node:fs/promises";
import { MemDot } from "../src/index.js";

const baseUrl = process.env.API_URL ?? "http://localhost:8787";
const origin = process.env.WEB_ORIGIN ?? "http://localhost:3100";
const repo = (path: string) => new URL(`../../../${path}`, import.meta.url);

// The sign-in material stays outside git: context/ is never published.
const accounts = JSON.parse(
  await readFile(repo("context/memdot/demo-accounts.local.json"), "utf8"),
) as { ownerRecoveryCode: string; recipientRecoveryCode?: string };

const SPACE_NAME = "Agent memory demo";
const ASSISTED = [
  { text: "Priya leads the payments team at Flutterwave in Lagos.", user: "priya" },
  { text: "Priya's team uses pnpm and deploys only on Fridays.", user: "priya" },
  { text: "Tunde is on call for payments this month.", user: "priya" },
  { text: "Ben prefers short answers with code first.", user: "ben" },
];
const PRIVATE = [
  { text: "My thesis is on Yoruba oral history; my advisor is Dr. Adeyemi at UNILAG.", user: "me" },
  { text: "My favourite tea is Earl Grey.", user: "me" },
];

const owner = MemDot.create({ baseUrl, origin, client: "seed-memory" });
await owner.account.signInWithRecoveryCode(accounts.ownerRecoveryCode);
await owner.account.unlockWithRecoveryCode(accounts.ownerRecoveryCode);

const spaces = await owner.spaces.list();
const space =
  spaces.find((candidate) => candidate.name === SPACE_NAME) ??
  (await owner.spaces.create({ name: SPACE_NAME }));
console.log(`Space ${space.id}`);

const namespaces = await owner.memories.namespaces(space.id);
const namespaceNamed = async (name: string, mode: "assisted" | "private") =>
  namespaces.find((row) => row.name === name) ??
  (await owner.memories.createNamespace({ spaceId: space.id, name, mode }));
const assisted = await namespaceNamed("Support bot", "assisted");
const privateNs = await namespaceNamed("My notes", "private");

let lastEvent: string | null = null;
for (const { text, user } of ASSISTED) {
  const added = await owner.memories.add(text, {
    namespaceId: assisted.id,
    userId: user,
    infer: false,
    source: { label: "demo" },
    wait: "chain",
  });
  console.log(added.results.length ? `Assisted: ${text}` : `Already there: ${text}`);
  lastEvent = added.results.length && added.eventId ? added.eventId : lastEvent;
}
for (const { text, user } of PRIVATE) {
  const added = await owner.memories.add(text, {
    namespaceId: privateNs.id,
    userId: user,
    infer: false,
    source: { label: "demo" },
    wait: "chain",
  });
  console.log(added.results.length ? `Private: ${text}` : `Already there: ${text}`);
}

const hits = await owner.memories.search("Who is on call?", {
  namespaceId: assisted.id,
  mode: "keyword",
});
const onCall = hits.find((hit) => hit.memory.includes("Tunde"));
if (!onCall) throw new Error("the demo memory didn't come back");
for (let attempt = 0; attempt < 40; attempt += 1) {
  if ((await owner.memories.get(onCall.id)).segment?.status === "stored") break;
  await new Promise((resolve) => setTimeout(resolve, 3_000));
}
const stored = await owner.memories.get(onCall.id);
// A node can stall on a cold connection; "inconclusive" means ask again, anything else is an answer.
let verified = await owner.files.verify(stored.segment?.id as string);
for (let attempt = 0; attempt < 2 && verified.inconclusive; attempt += 1) {
  verified = await owner.files.verify(stored.segment?.id as string);
}
if (!verified.ok) throw new Error(`verification failed: ${JSON.stringify(verified)}`);
const proof = await owner.proof.cid(stored.segment?.cid as string);

const privateVerified = await owner.memories.search("what should I drink?", {
  namespaceId: privateNs.id,
});
const snapshotCid = await owner.memories.saveIndex(privateNs.id);
const snapshot = await owner.proof.cid(snapshotCid);

// Another account's filters must stop at its own namespace, whatever shape they take.
if (accounts.recipientRecoveryCode) {
  const other = MemDot.create({ baseUrl, origin, client: "seed-memory" });
  await other.account.signInWithRecoveryCode(accounts.recipientRecoveryCode);
  await other.account.unlockWithRecoveryCode(accounts.recipientRecoveryCode);
  const otherSpace =
    (await other.spaces.list())[0] ?? (await other.spaces.create({ name: "Filter check" }));
  const otherNamespaces = await other.memories.namespaces(otherSpace.id);
  const otherNamespace =
    otherNamespaces.find((row) => row.mode === "assisted") ??
    (await other.memories.createNamespace({
      spaceId: otherSpace.id,
      name: "Filter check",
      mode: "assisted",
    }));
  let reached = 0;
  for (const filters of [
    { memory_ids: { nin: ["00000000-0000-0000-0000-000000000000"] } },
    { user_id: { nin: ["x"] } },
    { created_at: { nin: ["2020-01-01"] } },
    { metadata: { team: { nin: ["x"] } } },
    { NOT: [{ user_id: { nin: ["x"] } }] },
  ]) {
    const page = await other.memories.list({
      namespaceId: otherNamespace.id,
      filters,
      showExpired: true,
    });
    reached += page.count;
  }
  if (reached !== 0) throw new Error(`another account's filters reached ${reached} memories`);
  console.log("Another account's filters reach none of these memories.");
  await other.close();
}

const evidence = {
  stage: "S08",
  at: new Date().toISOString(),
  app: origin,
  api: baseUrl,
  spaceId: space.id,
  assisted: {
    namespaceId: assisted.id,
    cid: stored.segment?.cid,
    txHash: proof.firstStore?.txHash,
    block: proof.firstStore?.block,
    verified: verified.blobs,
  },
  private: {
    namespaceId: privateNs.id,
    recalledOnDevice: privateVerified.length,
    snapshot: {
      cid: snapshotCid,
      txHash: snapshot.firstStore?.txHash,
      block: snapshot.firstStore?.block,
    },
  },
};
await writeFile(
  repo(`docs/evidence/s08-seed-${evidence.at.slice(0, 10)}.json`),
  `${JSON.stringify(evidence, null, 2)}\n`,
);
console.log("Evidence written to docs/evidence.");
await owner.close();
process.exit(0);
