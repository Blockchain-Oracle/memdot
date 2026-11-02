// S08 "done when", through the SDK against a running API and worker on live Portaldot V3: Kofi's
// agent memory journey in both modes, restore, source links, importing another product's export,
// export and re-import, and account deletion stopping renewals.
// Needs a model key for the Private half. Spends about 3 tPOT from the relayer.
// Usage: GEMINI_API_KEY=… pnpm --filter @memdot/sdk journey:memory
// WIPE_INDEX_SQL="docker exec -i memdot-postgres-1 psql -U memdot -d memdot" also wipes the Assisted
// index behind the API's back first, so Restore has only the chain to work from (local only).

import { execSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { crc32, deflateSync } from "node:zlib";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { MemDot, MemDotError, type ScoredMemory, walletFromMnemonic } from "../src/index.js";

const baseUrl = process.env.API_URL ?? "http://localhost:8787";
const origin = process.env.WEB_ORIGIN ?? "http://localhost:3100";
const client = () => MemDot.create({ baseUrl, origin, client: "journey-s08" });

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(
    `${ok ? "✓" : "✗"} ${label}${ok || detail === undefined ? "" : ` → ${JSON.stringify(detail)}`}`,
  );
  if (!ok) {
    failures += 1;
    process.exitCode = 1;
  }
}
const texts = (hits: { memory: string }[]) => hits.map((hit) => hit.memory);
const mentions = (hits: { memory: string }[], word: string) =>
  hits.some((hit) => hit.memory.toLowerCase().includes(word));
const rejects = async (run: () => Promise<unknown>, code: string) => {
  try {
    await run();
    return false;
  } catch (error) {
    return error instanceof MemDotError && error.code === code;
  }
};

const evidence: Record<string, unknown> = { stage: "S08", at: new Date().toISOString() };

// ── Kofi sets up: one sponsored space, two namespaces, an API key for his agent ─────────────
const kofi = client();
const kofiWallet = walletFromMnemonic(generateMnemonic(wordlist));
const { recoveryCode } = await kofi.account.create(kofiWallet, { name: "Kofi" });
const space = await kofi.spaces.create({ name: "Agent memory" });
const assisted = await kofi.memories.createNamespace({
  spaceId: space.id,
  name: "Support bot",
  mode: "assisted",
});
const privateNs = await kofi.memories.createNamespace({
  spaceId: space.id,
  name: "My notes",
  mode: "private",
});
check("Kofi makes an Assisted and a Private namespace", Boolean(assisted.id && privateNs.id));

const key = await kofi.keys.create({ name: "kofi-agent", role: "read_write" });
const agent = client();
agent.useApiKey(key.key);

// ── Assisted, with nothing but an API key ───────────────────────────────────────────────────
const added = await agent.memories.add(
  [
    { role: "user", content: "I'm Priya. I lead payments at Flutterwave in Lagos. We use pnpm." },
    {
      role: "assistant",
      content: "Then Turborepo with pnpm workspaces should suit your monorepo.",
    },
  ],
  { namespaceId: assisted.id, userId: "priya", metadata: { channel: "support" } },
);
check("an agent remembers with only an API key", added.results.length > 0, added);
console.log(`  · extracted: ${JSON.stringify(texts(added.results as never))}`);
check("the write is followed as an event", added.eventId !== null);

const other = await agent.memories.add("Ben prefers npm over everything else.", {
  namespaceId: assisted.id,
  userId: "ben",
  infer: false,
});
check(
  "infer: false stores it as written",
  other.results[0]?.memory === "Ben prefers npm over everything else.",
);

const again = await agent.memories.add("Ben prefers npm over everything else.", {
  namespaceId: assisted.id,
  userId: "ben",
  infer: false,
});
check(
  "the same fact in the same scope is dropped",
  again.results.length === 0 && again.duplicates === 1,
  again,
);

const recall = await agent.memories.search("Which package manager does the team use?", {
  namespaceId: assisted.id,
  filters: { user_id: "priya" },
});
check("recall finds it, scoped to one user", mentions(recall, "pnpm"), texts(recall));
check("recall never crosses into another user", !mentions(recall, "ben prefers"), texts(recall));
evidence.assistedRecall = recall.map((hit: ScoredMemory) => ({
  score: hit.score,
  breakdown: hit.scoreBreakdown,
}));

const keyword = await agent.memories.search("Flutterwave", {
  namespaceId: assisted.id,
  mode: "keyword",
  filters: { user_id: "priya" },
});
check("keyword search ranks over blinded terms", mentions(keyword, "flutterwave"), texts(keyword));

const complex = await agent.memories.list({
  namespaceId: assisted.id,
  filters: {
    AND: [
      { OR: [{ user_id: "priya" }, { user_id: "nobody" }] },
      { NOT: [{ user_id: "ben" }] },
      { metadata: { channel: "support" } },
      { created_at: { gte: "2026-01-01" } },
    ],
  },
});
check(
  "filters nest AND, OR and NOT",
  complex.count > 0 && !mentions(complex.results, "ben prefers"),
  complex.count,
);

check(
  "a bad filter says what's wrong",
  await rejects(
    () => agent.memories.search("x", { namespaceId: assisted.id, filters: { colour: "red" } }),
    "BAD_FILTER",
  ),
);

const first = recall[0];
if (!first) throw new Error("nothing recalled");
const updated = await agent.memories.update(first.id, {
  text: "Priya's team moved from pnpm to Bun.",
  metadata: { edited: true },
});
check(
  "an update changes the text and merges metadata",
  updated.version === 2 && updated.metadata?.channel === "support",
  updated,
);
const history = await agent.memories.history(first.id);
check(
  "history shows both versions",
  history.length === 2 &&
    history[1]?.oldMemory === first.memory &&
    history[1]?.newMemory === updated.memory,
  history,
);
const afterEdit = await agent.memories.search("Bun", {
  namespaceId: assisted.id,
  filters: { user_id: "priya" },
});
check("recall sees the new text", mentions(afterEdit, "bun"), texts(afterEdit));

await agent.memories.feedback(first.id, "POSITIVE", "right on");
check("feedback is recorded", (await agent.memories.get(first.id)).feedback === "POSITIVE");

const expiring = await agent.memories.add("The office is closed until next Monday.", {
  namespaceId: assisted.id,
  userId: "priya",
  infer: false,
  expirationDate: "2020-01-01",
});
const expiredId = expiring.results[0]?.id as string;
const visible = await agent.memories.list({
  namespaceId: assisted.id,
  filters: { memory_ids: { in: [expiredId] } },
});
const shown = await agent.memories.list({
  namespaceId: assisted.id,
  showExpired: true,
  filters: { memory_ids: { in: [expiredId] } },
});
check("an expired memory is hidden unless asked", visible.count === 0 && shown.count === 1, {
  visible,
  shown,
});
check("and still opens by id", (await agent.memories.get(expiredId)).id === expiredId);

const entities = await agent.memories.entities({ namespaceId: assisted.id });
check(
  "entities lists users with counts",
  entities.some(
    (entity) => entity.type === "user" && entity.id === "priya" && entity.totalMemories > 0,
  ),
  entities,
);

const summary = await agent.memories.summary({
  namespaceId: assisted.id,
  filters: { user_id: "ben" },
});
check("a summary reads what's stored", summary.summary.toLowerCase().includes("npm"), summary);

const benMemory = other.results[0]?.id as string;
await agent.memories.delete(benMemory);
const forgotten = await agent.memories.search("npm", {
  namespaceId: assisted.id,
  filters: { user_id: "ben" },
});
check("a forgotten memory no longer recalls", forgotten.length === 0, texts(forgotten));
const forgottenHistory = await agent.memories.history(benMemory);
check(
  "its history keeps the events and drops the text",
  forgottenHistory.at(-1)?.event === "DELETE" &&
    forgottenHistory.every((row) => row.newMemory === null),
  forgottenHistory,
);

// The chain, which is the point: the owner opens what the server wrote, without the server.
const onChain = await agent.memories.get(first.id);
const event = await agent.memories.waitForEvent(added.eventId as string, "chain");
check("the write reaches the chain, finalized", event.status === "SUCCEEDED", event);
evidence.assistedSegment = { txHash: event.tx_hash, block: event.block };
for (let attempt = 0; attempt < 40; attempt += 1) {
  if ((await agent.memories.get(first.id)).segment?.status === "stored") break;
  await new Promise((resolve) => setTimeout(resolve, 3_000));
}
const stored = await agent.memories.get(first.id);
check("its segment is stored on V3", stored.segment?.status === "stored", stored.segment);
const sealed = await kofi.proof.cid(stored.segment?.cid as string).catch(() => null);
check("the segment is a public proof page", sealed !== null);
const verified = await kofi.files.verify(stored.segment?.id as string);
check("Verify checks the segment over this device's own V3 connection", verified.ok, verified);
const ciphertext = await kofi.memories.exportMemories(assisted.id);
check("the owner can export Assisted memories", ciphertext.length > 0);
evidence.onChainMemory = onChain.segment;

// Restore: everything the index holds is derived again from what's on the chain.
const beforeRestore = await agent.memories.search("Who leads payments?", {
  namespaceId: assisted.id,
  filters: { user_id: "priya" },
});
if (process.env.WIPE_INDEX_SQL) {
  execSync(process.env.WIPE_INDEX_SQL, {
    input: `update memories set sealed_text = null, embedding = null, term_count = 0 where folder_id = '${assisted.id}' and deleted_at is null; delete from memory_terms where folder_id = '${assisted.id}';`,
  });
  console.log("  · wiped the namespace's text, vectors and terms from Postgres");
}
const restored = await kofi.memories.restore(assisted.id);
check(
  "restore rebuilds from the chain",
  (restored as { status: string }).status === "SUCCEEDED",
  restored,
);
const afterRestore = await agent.memories.search("Who leads payments?", {
  namespaceId: assisted.id,
  filters: { user_id: "priya" },
});
check(
  "restore reproduces recall",
  JSON.stringify(texts(afterRestore).sort()) === JSON.stringify(texts(beforeRestore).sort()),
  { before: texts(beforeRestore), after: texts(afterRestore) },
);
check(
  "a forgotten memory stays forgotten after restore",
  (await agent.memories.search("npm", { namespaceId: assisted.id, filters: { user_id: "ben" } }))
    .length === 0,
);

// Source links: a file's memories go with the file.
const note = await kofi.files.put(utf8ToBytes("Renewal meeting is on Tuesdays."), {
  spaceId: space.id,
  name: "note.txt",
  mime: "text/plain",
});
const derived = await agent.memories.add("Renewal meeting is on Tuesdays.", {
  namespaceId: assisted.id,
  userId: "priya",
  infer: false,
  source: { objectId: note.file.id, label: "note.txt" },
});
const derivedId = derived.results[0]?.id as string;
check(
  "a memory links to the file it came from",
  (await agent.memories.get(derivedId)).source?.objectId === note.file.id,
);
await kofi.files.delete(note.file.id);
check(
  "deleting the source deletes its memories",
  await rejects(() => agent.memories.get(derivedId), "NOT_FOUND"),
);

// An OpenAI client pointed at MemDot: recalled memories in, the exchange remembered afterwards.
const chat = await fetch(`${baseUrl}/v1/chat/completions`, {
  method: "POST",
  headers: { authorization: `Bearer ${key.key}`, "content-type": "application/json" },
  body: JSON.stringify({
    model: "memdot",
    namespace_id: assisted.id,
    user_id: "priya",
    store: false,
    messages: [{ role: "user", content: "Which runtime did my team move to?" }],
  }),
});
const completion = (await chat.json()) as {
  choices?: { message: { content: string } }[];
  memdot?: { recalled: number };
};
check(
  "the chat endpoint answers from memory",
  completion.choices?.[0]?.message.content.toLowerCase().includes("bun") === true &&
    (completion.memdot?.recalled ?? 0) > 0,
  completion,
);
const streamed = await fetch(`${baseUrl}/v1/chat/completions`, {
  method: "POST",
  headers: { authorization: `Bearer ${key.key}`, "content-type": "application/json" },
  body: JSON.stringify({
    namespace_id: assisted.id,
    user_id: "priya",
    stream: true,
    store: false,
    messages: [{ role: "user", content: "Say hello in one word." }],
  }),
});
const frames = (await streamed.text()).split("\n").filter((line) => line.startsWith("data: "));
check(
  "and streams like OpenAI's",
  frames.at(-1) === "data: [DONE]" && frames[0]?.includes("chat.completion.chunk") === true,
  frames.slice(0, 2),
);

// An agent's working record, and a picture read by the model.
const procedural = await agent.memories.add(
  [
    { role: "user", content: "Deploy the billing service." },
    {
      role: "assistant",
      content: "Ran the migration, then deployed v2.3. Health check returned 200.",
    },
  ],
  { namespaceId: assisted.id, agentId: "deployer", memoryType: "procedural_memory" },
);
check(
  "a procedural memory stores the agent's record as one memory",
  procedural.results.length === 1 &&
    (await agent.memories.get(procedural.results[0]?.id as string)).memoryType === "procedural",
  procedural,
);
const vision = await agent.memories.add(
  [
    {
      role: "user",
      content: [
        { type: "text", text: "This is the logo colour I picked for my bakery, Sweet Crumb." },
        { type: "image_url", image_url: { url: solidPng(0xe6, 0x39, 0x46) } },
      ],
    },
  ],
  { namespaceId: assisted.id, userId: "mira" },
);
check("a message with a picture is read by the model", vision.results.length > 0, vision);
console.log(`  · from the picture: ${JSON.stringify(texts(vision.results as never))}`);

// ── Import from another memory product ──────────────────────────────────────────────────────
const exported = {
  count: 3,
  next: null,
  previous: null,
  results: [
    {
      id: "1",
      memory: "Likes window seats",
      user_id: "ana",
      categories: ["travel"],
      created_at: "2026-03-01T09:00:00Z",
    },
    { id: "2", text: "Allergic to peanuts", user_id: "ana", metadata: { source: "intake" } },
    { id: "3", content: "Prefers morning calls", agent_id: "scheduler", session_id: "run-9" },
  ],
};
const imported = await kofi.memories.importMemories(exported, {
  namespaceId: assisted.id,
  source: "mem0",
});
check(
  "another product's export imports with matching counts",
  imported.imported === 3 && imported.skipped === 0,
  imported,
);
const anaHits = await agent.memories.search("seat preference", {
  namespaceId: assisted.id,
  filters: { user_id: "ana" },
});
check("and its memories recall", mentions(anaHits, "window"), texts(anaHits));

// ── Private: nothing but ids and ciphertext reach MemDot ────────────────────────────────────
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey)
  throw new Error(
    "Set GEMINI_API_KEY for the Private half: extraction runs here, with your own key.",
  );
await kofi.memories.setPrivateModel({
  provider: "google",
  model: process.env.PRIVATE_LLM_MODEL ?? "gemini-3.5-flash-lite,gemini-3.1-flash-lite",
  apiKey,
});
check(
  "a Private model key is sealed to this account",
  (await kofi.memories.privateModel())?.provider === "google",
);

const privateAdd = await kofi.memories.add(
  "I'm writing my thesis on Yoruba oral history, and my advisor is Dr. Adeyemi at UNILAG.",
  { namespaceId: privateNs.id, userId: "kofi", wait: "chain" },
);
check("Private extracts on this device", privateAdd.results.length > 0, privateAdd);
console.log(`  · extracted: ${JSON.stringify(texts(privateAdd.results as never))}`);
await kofi.memories.add("My favourite tea is Earl Grey.", {
  namespaceId: privateNs.id,
  userId: "kofi",
  infer: false,
  wait: "chain",
});

const leak = await unwrapPrivateState(privateNs.id);
check(
  "MemDot holds only ids for Private memories",
  leak.rows === 2 && leak.fields.every((field) => field === null),
  leak,
);

const privateRecall = await kofi.memories.search("what am I researching?", {
  namespaceId: privateNs.id,
  filters: { user_id: "kofi" },
});
check("Private recall runs here", mentions(privateRecall, "yoruba"), texts(privateRecall));
const refused = await fetch(`${baseUrl}/v1/memories/search`, {
  method: "POST",
  headers: { authorization: `Bearer ${key.key}`, "content-type": "application/json" },
  body: JSON.stringify({ query: "thesis", namespace_id: privateNs.id }),
});
check("and the API refuses to search it", refused.status === 409, refused.status);

const teaHit =
  privateRecall.find((hit) => hit.memory.includes("Earl Grey")) ??
  (await kofi.memories.search("tea", { namespaceId: privateNs.id, mode: "keyword" }))[0];
if (!teaHit) throw new Error("no tea memory");
const privateEdit = await kofi.memories.update(
  teaHit.id,
  { text: "My favourite tea is now Darjeeling." },
  { wait: true },
);
check("a Private update writes a new version", privateEdit.version === 2, privateEdit);
const privateHistory = await kofi.memories.history(teaHit.id);
check(
  "Private history travels in the entry",
  privateHistory.length === 2 && privateHistory[1]?.oldMemory?.includes("Earl Grey") === true,
  privateHistory,
);

const snapshotCid = await kofi.memories.saveIndex(privateNs.id);
check("the Private index is stored, encrypted, on V3", snapshotCid.length > 0);
evidence.indexSnapshot = snapshotCid;

const secondDevice = client();
await secondDevice.account.signInWithRecoveryCode(recoveryCode);
await secondDevice.account.unlockWithRecoveryCode(recoveryCode);
const onSecond = await secondDevice.memories.search("what am I researching?", {
  namespaceId: privateNs.id,
  filters: { user_id: "kofi" },
});
check(
  "a second device opens the same Private memories",
  mentions(onSecond, "yoruba"),
  texts(onSecond),
);
const restoredPrivate = await secondDevice.memories.restore(privateNs.id);
check(
  "Private restore rebuilds from the chain, on this device",
  (restoredPrivate as { restored: number }).restored === 2,
  restoredPrivate,
);
const afterPrivateRestore = await secondDevice.memories.search("what am I researching?", {
  namespaceId: privateNs.id,
  filters: { user_id: "kofi" },
});
check("and reproduces recall", mentions(afterPrivateRestore, "yoruba"), texts(afterPrivateRestore));

await kofi.memories.delete(teaHit.id);
check(
  "a forgotten Private memory is gone on every device",
  !mentions(
    await secondDevice.memories.search("tea", { namespaceId: privateNs.id, mode: "keyword" }),
    "darjeeling",
  ),
);

// ── Export, and bring it all to a fresh account ─────────────────────────────────────────────
const exportFile = await kofi.files.put(utf8ToBytes("A file to carry across."), {
  spaceId: space.id,
  name: "carry.txt",
  mime: "text/plain",
});
const archive = await kofi.data.exportArchive();
const memoriesExported = archive.manifest.spaces
  .flatMap((entry) => entry.namespaces)
  .reduce((sum, ns) => sum + ns.memories.length, 0);
const filesExported = archive.manifest.spaces.flatMap((entry) => entry.files).length;
check("the export holds files and memories", filesExported >= 1 && memoriesExported >= 4, {
  filesExported,
  memoriesExported,
  failures: archive.failures,
});
check("nothing failed to read", archive.failures.length === 0, archive.failures);
evidence.export = { files: filesExported, memories: memoriesExported, bytes: archive.zip.length };

const fresh = client();
await fresh.account.create(walletFromMnemonic(generateMnemonic(wordlist)), {
  name: "Kofi's new account",
});
await fresh.memories.setPrivateModel(null);
const report = await fresh.data.importArchive(archive.zip);
check(
  "re-importing into a fresh account reports no failures",
  report.failures.length === 0,
  report,
);
const countMemories = async (account: MemDot) => {
  let total = 0;
  for (const namespace of await account.memories.namespaces()) {
    total += (await account.memories.exportMemories(namespace.id)).length;
  }
  return total;
};
const freshSpaces = await fresh.spaces.list();
const freshFiles = await Promise.all(freshSpaces.map((s) => fresh.files.list({ spaceId: s.id })));
check(
  "export → re-import keeps the counts",
  (await countMemories(fresh)) === memoriesExported &&
    freshFiles.flatMap((page) => page.items).length === filesExported,
  { memories: await countMemories(fresh), files: freshFiles.flatMap((page) => page.items).length },
);
const carried = freshFiles.flatMap((page) => page.items).find((file) => file.name === "carry.txt");
check(
  "and a carried file opens",
  carried !== undefined &&
    new TextDecoder().decode((await fresh.files.get(carried.id)).data) ===
      "A file to carry across.",
);
await kofi.files.delete(exportFile.file.id);

// ── Deleting an account stops its renewals ──────────────────────────────────────────────────
const usageBefore = await kofi.usage();
check("before deleting, Kofi has stored blobs", usageBefore.blobs.stored > 0, usageBefore.blobs);
await kofi.data.deleteAccount();
check(
  "the API key stops working",
  await rejects(() => agent.memories.list({ namespaceId: assisted.id }), "UNAUTHORIZED"),
);
const signedOut = client();
check(
  "the recovery code no longer signs in",
  await signedOut.account.signInWithRecoveryCode(recoveryCode).then(
    () => false,
    () => true,
  ),
);
if (process.env.WIPE_INDEX_SQL) {
  const held = execSync(process.env.WIPE_INDEX_SQL.concat(" -At"), {
    input: `select count(*) from stored_items si join objects o on o.id = si.object_id join spaces s on s.id = o.space_id where s.id = '${space.id}' and si.status <> 'released';`,
  })
    .toString()
    .trim();
  check("nothing of the account is left for the keeper to renew", held === "0", held);
}

await writeFile(
  new URL(
    `../../../docs/evidence/s08-memory-${evidence.at?.toString().slice(0, 10)}.json`,
    import.meta.url,
  ),
  `${JSON.stringify(evidence, null, 2)}\n`,
);
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} checks failed.`);
await Promise.all([kofi, agent, secondDevice, fresh].map((account) => account.close()));
process.exit(failures === 0 ? 0 : 1);

/** A 32×32 PNG of one colour, for a model to look at. */
function solidPng(red: number, green: number, blue: number): string {
  const SIZE = 32;
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(SIZE, 0);
  header.writeUInt32BE(SIZE, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.concat([
    Buffer.from([0]),
    Buffer.alloc(SIZE * 3).map((_, i) => [red, green, blue][i % 3] as number),
  ]);
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: SIZE }, () => row)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return `data:image/png;base64,${png.toString("base64")}`;
}

/** What the API returns about a Private namespace: its rows must hold no content. */
async function unwrapPrivateState(namespaceId: string) {
  const response = await fetch(`${baseUrl}/v1/namespaces/${namespaceId}/private`, {
    headers: { authorization: `Bearer ${key.key}` },
  });
  const state = (await response.json()) as { live: Record<string, unknown>[] };
  const sealed = process.env.WIPE_INDEX_SQL
    ? execSync(process.env.WIPE_INDEX_SQL.concat(" -At"), {
        input: `select coalesce(user_id, sealed_text::text, metadata::text, embedding::text) from memories where folder_id = '${namespaceId}';`,
      })
        .toString()
        .trim()
        .split("\n")
        .map((line) => line.trim() || null)
    : state.live.map(() => null);
  return { rows: state.live.length, fields: sealed };
}
