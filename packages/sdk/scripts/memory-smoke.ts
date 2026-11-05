// S08: a live check of memory on a deployed service, with no model key involved anywhere. Assisted
// memories stored as written and found by keyword, Private ones embedded on this machine, the chain
// underneath both, then the account deleted. Spends several tPOT from the relayer, and makes accounts,
// so run it on a local stack.
// Usage: API_URL=… WEB_ORIGIN=… pnpm --filter @memdot/sdk smoke:memory

import { writeFile } from "node:fs/promises";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { MemDot, MemDotError, walletFromMnemonic } from "../src/index.js";

const baseUrl = process.env.API_URL ?? "http://localhost:8787";
const origin = process.env.WEB_ORIGIN ?? "http://localhost:3100";
const client = () => MemDot.create({ baseUrl, origin, client: "memory-smoke" });

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : ` → ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
}

const owner = client();
const { recoveryCode } = await owner.account.create(
  walletFromMnemonic(generateMnemonic(wordlist)),
  { name: "Memory smoke" },
);
const space = await owner.spaces.create({ name: "Memory smoke" });
const assisted = await owner.memories.createNamespace({
  spaceId: space.id,
  name: "Assisted",
  mode: "assisted",
});
const privateNs = await owner.memories.createNamespace({
  spaceId: space.id,
  name: "Private",
  mode: "private",
});
const key = await owner.keys.create({ name: "smoke", role: "read_write" });
const agent = client();
agent.setApiKey(key.key);

// ── Assisted, with an API key alone ─────────────────────────────────────────────────────────
const added = await agent.memories.add("Priya leads payments at Flutterwave in Lagos.", {
  namespaceId: assisted.id,
  userId: "priya",
  infer: false,
  wait: "chain",
});
check("Assisted: an API key stores a memory, finalized on V3", added.status === "SUCCEEDED", added);
const id = added.results[0]?.id as string;

const keyword = await agent.memories.search("Flutterwave", {
  namespaceId: assisted.id,
  mode: "keyword",
  filters: { user_id: "priya" },
});
check("Assisted: keyword search over blinded terms", keyword[0]?.id === id, keyword);

await agent.memories.update(id, { text: "Priya leads payments at Flutterwave in Accra." });
const history = await agent.memories.history(id);
check("Assisted: an update keeps its history", history.length === 2, history);

for (let attempt = 0; attempt < 40; attempt += 1) {
  if ((await agent.memories.get(id)).segment?.status === "stored") break;
  await new Promise((resolve) => setTimeout(resolve, 3_000));
}
const stored = await agent.memories.get(id);
check("Assisted: the new version is stored", stored.segment?.status === "stored", stored.segment);
// A node can stall on a cold connection; "inconclusive" means ask again, anything else is an answer.
let verified = await owner.files.verify(stored.segment?.id as string);
for (let attempt = 0; attempt < 2 && verified.inconclusive; attempt += 1) {
  verified = await owner.files.verify(stored.segment?.id as string);
}
check("Assisted: Verify over this machine's own V3 connection", verified.ok, verified);

// Forgetting most of a segment gets it rewritten: the survivor moves, the old blob stops renewing.
const trio = await agent.memories.importMemories(
  [
    { memory: "Keep this one: the office is in Yaba.", user_id: "priya" },
    { memory: "Forget this one: the wifi password rotates weekly.", user_id: "priya" },
    { memory: "Forget this too: lunch is at noon.", user_id: "priya" },
  ],
  { namespaceId: assisted.id, source: "smoke" },
);
check("Assisted: an import stores as one segment", trio.imported === 3, trio);
const listed = await agent.memories.list({
  namespaceId: assisted.id,
  filters: { keywords: "forget" },
});
const survivor = (
  await agent.memories.search("office", { namespaceId: assisted.id, mode: "keyword" })
)[0];
const oldSegment = survivor?.segment?.id;
await agent.memories.batchDelete(listed.results.map((memory) => memory.id));
for (let attempt = 0; attempt < 40; attempt += 1) {
  const moved = await agent.memories.get(survivor?.id as string);
  if (moved.segment?.id !== oldSegment && moved.segment?.status === "stored") break;
  await new Promise((resolve) => setTimeout(resolve, 3_000));
}
const moved = await agent.memories.get(survivor?.id as string);
check(
  "Assisted: a mostly forgotten segment is rewritten by itself",
  moved.segment?.id !== oldSegment && moved.segment?.status === "stored",
  { oldSegment, now: moved.segment },
);
check("Assisted: the survivor still reads", moved.memory.includes("Yaba"), moved);

const restored = await owner.memories.restore(assisted.id);
check(
  "Assisted: Restore reads it all back from the chain",
  (restored as { status: string }).status === "SUCCEEDED",
  restored,
);
check(
  "Assisted: still found, at its newest version",
  (await agent.memories.get(id)).memory.includes("Accra"),
);

// Another account, trying every filter shape that has an OR inside it.
const stranger = client();
await stranger.account.create(walletFromMnemonic(generateMnemonic(wordlist)), { name: "Stranger" });
const strangerSpace = await stranger.spaces.create({ name: "Stranger" });
const strangerNs = await stranger.memories.createNamespace({
  spaceId: strangerSpace.id,
  name: "Stranger",
  mode: "assisted",
});
const probes: Record<string, unknown>[] = [
  { memory_ids: { nin: ["00000000-0000-0000-0000-000000000000"] } },
  { user_id: { nin: ["x"] } },
  { created_at: { nin: ["2020-01-01"] } },
  { metadata: { team: { nin: ["x"] } } },
  { categories: { nin: ["x"] } },
  { NOT: [{ user_id: { nin: ["x"] } }] },
  { OR: [{ user_id: { nin: ["x"] } }] },
];
let reached = 0;
for (const filters of probes) {
  const page = await stranger.memories.list({
    namespaceId: strangerNs.id,
    filters,
    showExpired: true,
  });
  reached += page.count;
}
check("Another account's filters reach none of these memories", reached === 0, reached);
await stranger.close();

// ── Private, on this machine ────────────────────────────────────────────────────────────────
const privateAdd = await owner.memories.add("My favourite tea is Earl Grey.", {
  namespaceId: privateNs.id,
  userId: "me",
  infer: false,
  wait: "chain",
});
check("Private: stored as written, sealed here", privateAdd.results.length === 1, privateAdd);
const semantic = await owner.memories.search("what should I drink?", {
  namespaceId: privateNs.id,
});
check("Private: search by meaning, embedded on this machine", semantic.length === 1, semantic);

// A device-side rewrite: two memories, one forgotten, then merged here.
const bulk = await owner.memories.importMemories(
  [
    { memory: "Merge me: bring the blue notebook.", user_id: "me" },
    { memory: "Merge me too: call the printer.", user_id: "me" },
    { memory: "And me: return the library card.", user_id: "me" },
  ],
  { namespaceId: privateNs.id, source: "smoke" },
);
check("Private: an import stores as one segment", bulk.imported === 3, bulk);
const notebook = await owner.memories.search("printer", {
  namespaceId: privateNs.id,
  mode: "keyword",
});
const card = await owner.memories.search("library", { namespaceId: privateNs.id, mode: "keyword" });
await owner.memories.batchDelete([notebook[0]?.id as string, card[0]?.id as string]);
const compacted = (await owner.memories.compact(privateNs.id)) as {
  segments: number;
  moved: number;
};
check("Private: a device merges a mostly forgotten segment", compacted.moved === 1, compacted);
const afterMerge = await owner.memories.search("notebook", {
  namespaceId: privateNs.id,
  mode: "keyword",
});
check(
  "Private: the survivor still reads",
  afterMerge[0]?.memory.includes("blue") === true,
  afterMerge,
);

const secondDevice = client();
await secondDevice.account.signInWithRecoveryCode(recoveryCode);
await secondDevice.account.unlockWithRecoveryCode(recoveryCode);
const onSecond = await secondDevice.memories.restore(privateNs.id);
check(
  "Private: a second device rebuilds it from the chain",
  (onSecond as { restored: number }).restored === 2,
  onSecond,
);

const refused = await fetch(`${baseUrl}/v1/memories/search`, {
  method: "POST",
  headers: { authorization: `Bearer ${key.key}`, "content-type": "application/json" },
  body: JSON.stringify({ query: "tea", namespace_id: privateNs.id }),
});
check("Private: the API refuses to search it", refused.status === 409, refused.status);

// ── Evidence, then gone ─────────────────────────────────────────────────────────────────────
const event = await agent.memories.event(added.eventId as string);
const evidence = {
  stage: "S08",
  at: new Date().toISOString(),
  app: origin,
  api: baseUrl,
  assisted: {
    namespaceId: assisted.id,
    cid: stored.segment?.cid,
    block: stored.segment?.block,
    firstStore: { txHash: event.tx_hash, block: event.block },
  },
};
await writeFile(
  new URL(`../../../docs/evidence/s08-live-${evidence.at.slice(0, 10)}.json`, import.meta.url),
  `${JSON.stringify(evidence, null, 2)}\n`,
);

const exported = await owner.data.exportArchive();
const memories = exported.manifest.spaces
  .flatMap((entry) => entry.namespaces)
  .reduce((sum, ns) => sum + ns.memories.length, 0);
check("The export holds what's left", memories === 4 && exported.failures.length === 0, {
  memories,
  failures: exported.failures,
});

await owner.data.deleteAccount();
const gone = await agent.memories.list({ namespaceId: assisted.id }).then(
  () => false,
  (error: unknown) => error instanceof MemDotError && error.status === 401,
);
check("Deleting the account stops its API key", gone);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} checks failed.`);
await Promise.all([owner, agent, secondDevice].map((account) => account.close()));
process.exit(failures === 0 ? 0 : 1);
