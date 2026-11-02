// S08: the model-backed half of memory on a deployed service, through the demo account: its seeded
// memories get vectors, a conversation is distilled by the shared model, recall works by meaning, a
// picture is read, and the chat endpoint answers from memory. Uses about 3 model calls of the account's
// daily allowance. Run seed:memory first. The API key it mints is revoked at the end.
// Usage: API_URL=… WEB_ORIGIN=… pnpm --filter @memdot/sdk live:memory

import { readFile, writeFile } from "node:fs/promises";
import { crc32, deflateSync } from "node:zlib";
import { MemDot, type ScoredMemory } from "../src/index.js";

const baseUrl = process.env.API_URL ?? "http://localhost:8787";
const origin = process.env.WEB_ORIGIN ?? "http://localhost:3100";
const repo = (path: string) => new URL(`../../../${path}`, import.meta.url);
const NAMESPACE_NAME = "Support bot";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : ` → ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
}
const texts = (hits: { memory: string | null }[]) => hits.map((hit) => hit.memory);
const round = (value: number) => Math.round(value * 1000) / 1000;

// The sign-in material stays outside git: context/ is never published.
const accounts = JSON.parse(
  await readFile(repo("context/memdot/demo-accounts.local.json"), "utf8"),
) as { ownerRecoveryCode: string };

const owner = MemDot.create({ baseUrl, origin, client: "memory-live" });
await owner.account.signInWithRecoveryCode(accounts.ownerRecoveryCode);
await owner.account.unlockWithRecoveryCode(accounts.ownerRecoveryCode);

const config = await owner.memories.configuration();
check(
  "the service has a shared model and embedder",
  config.llm.source === "service" && config.embedder.source === "service",
  { llm: config.llm.source, embedder: config.embedder.source },
);

const namespace = (await owner.memories.namespaces()).find(
  (row) => row.name === NAMESPACE_NAME && row.mode === "assisted",
);
if (!namespace) throw new Error("no demo namespace: run seed:memory first");

// What was seeded before there was an embedder has no vectors: Restore derives them from the chain.
const restored = await owner.memories.restore(namespace.id);
check(
  "Restore reads the demo memories back from the chain and embeds them",
  (restored as { status: string }).status === "SUCCEEDED",
  restored,
);
const byMeaning = await owner.memories.search("Who do I page when payments break at night?", {
  namespaceId: namespace.id,
  mode: "semantic",
  threshold: 0,
  topK: 3,
});
console.log(`  · by meaning: ${JSON.stringify(texts(byMeaning))}`);
check(
  "search by vectors alone ranks the on-call memory first",
  byMeaning[0]?.memory.includes("Tunde") === true && byMeaning[0].scoreBreakdown.semantic > 0,
  byMeaning.map((hit: ScoredMemory) => [hit.memory, hit.score]),
);

const added = await owner.memories.add(
  [
    {
      role: "user",
      content:
        "We decided today: Kemi takes over payments on-call from Tunde on December 1st, and the checkout service moves from Node to Bun next quarter.",
    },
    {
      role: "assistant",
      content: "Noted. I'd suggest running both runtimes side by side for two weeks first.",
    },
  ],
  { namespaceId: namespace.id, userId: "priya", source: { label: "memory-live" }, wait: "chain" },
);
console.log(`  · extracted: ${JSON.stringify(texts(added.results))}`);
check(
  "the shared model distills a conversation into facts",
  added.results.length > 0 && added.note === null && added.status === "SUCCEEDED",
  added,
);

const recalled = await owner.memories.search("Who is responsible for on-call in December?", {
  namespaceId: namespace.id,
  filters: { user_id: "priya" },
});
console.log(`  · recalled: ${JSON.stringify(texts(recalled.slice(0, 3)))}`);
check(
  "a new fact recalls, scoped to its user",
  recalled.some((hit) => hit.memory.includes("Kemi")),
  texts(recalled),
);

const key = await owner.keys.create({ name: "memory-live", role: "read_write" });
try {
  const chat = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key.key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "memdot",
      namespace_id: namespace.id,
      user_id: "priya",
      store: false,
      messages: [{ role: "user", content: "Who takes over payments on-call in December?" }],
    }),
  });
  const completion = (await chat.json()) as {
    choices?: { message: { content: string } }[];
    memdot?: { recalled: number };
    error?: unknown;
  };
  console.log(`  · chat: ${completion.choices?.[0]?.message.content ?? ""}`);
  check(
    "the chat endpoint answers from memory",
    completion.choices?.[0]?.message.content.includes("Kemi") === true &&
      (completion.memdot?.recalled ?? 0) > 0,
    completion,
  );

  const agent = MemDot.create({ baseUrl, origin, client: "memory-live" });
  agent.useApiKey(key.key);
  const picture = await agent.memories.add(
    [
      {
        role: "user",
        content: [
          { type: "text", text: "This is the logo colour I picked for my bakery, Sweet Crumb." },
          { type: "image_url", image_url: { url: solidPng(0xe6, 0x39, 0x46) } },
        ],
      },
    ],
    { namespaceId: namespace.id, userId: "mira", source: { label: "memory-live" } },
  );
  console.log(`  · from the picture: ${JSON.stringify(texts(picture.results))}`);
  check(
    "a message with a picture is read by the model",
    picture.results.length > 0 && picture.note === null,
    picture,
  );
} finally {
  await owner.keys.revoke(key.id);
}

const first = added.results[0]?.id;
if (!first) throw new Error("nothing extracted");
for (let attempt = 0; attempt < 40; attempt += 1) {
  if ((await owner.memories.get(first)).segment?.status === "stored") break;
  await new Promise((resolve) => setTimeout(resolve, 3_000));
}
const stored = await owner.memories.get(first);
// A node can stall on a cold connection; "inconclusive" means ask again, anything else is an answer.
let verified = await owner.files.verify(stored.segment?.id as string);
for (let attempt = 0; attempt < 2 && verified.inconclusive; attempt += 1) {
  verified = await owner.files.verify(stored.segment?.id as string);
}
check("the extracted memory is on V3 and verifies", verified.ok, verified);
const proof = await owner.proof.cid(stored.segment?.cid as string);

const evidence = {
  stage: "S08",
  at: new Date().toISOString(),
  app: origin,
  api: baseUrl,
  namespaceId: namespace.id,
  models: { llm: config.llm.provider, embedder: config.embedder.model },
  byMeaning: byMeaning.map((hit: ScoredMemory) => ({
    score: round(hit.score),
    semantic: round(hit.scoreBreakdown.semantic),
    bm25: round(hit.scoreBreakdown.bm25),
  })),
  extracted: {
    memories: added.results.length,
    cid: stored.segment?.cid,
    txHash: proof.firstStore?.txHash,
    block: proof.firstStore?.block,
  },
};
if (failures === 0) {
  await writeFile(
    repo(`docs/evidence/s08-live-${evidence.at.slice(0, 10)}.json`),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  console.log("Evidence written to docs/evidence.");
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} checks failed.`);
await owner.close();
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
