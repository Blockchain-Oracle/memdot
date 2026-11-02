import assert from "node:assert/strict";
import { test } from "node:test";
import {
  combineScores,
  dedupeKey,
  FilterError,
  LocalIndex,
  matchesFilter,
  type ParsedImport,
  parseFilter,
  parseMemoryImport,
  rank,
  readSnapshot,
  tokenize,
} from "../src/index.js";

const memory = {
  id: "m1",
  text: "Priya leads the Lagos office and prefers pnpm",
  userId: "alice",
  agentId: null,
  runId: "run-7",
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-05T10:00:00.000Z",
  expiresAt: null,
  categories: ["professional_details", "Technology"],
  metadata: { priority: 5, source: "email" },
};

test("filters: bare values, operators, and logic to any depth", () => {
  const matches = (filter: unknown) => matchesFilter(memory, parseFilter(filter));
  assert.equal(matches({ user_id: "alice" }), true);
  assert.equal(matches({ user_id: "bob" }), false);
  assert.equal(matches({ user_id: "alice", run_id: "other" }), false, "sibling keys mean AND");
  assert.equal(matches({ agent_id: "*" }), false, "* needs a value");
  assert.equal(matches({ run_id: "*" }), true);
  assert.equal(matches({ created_at: { gte: "2026-09-01" } }), true);
  assert.equal(matches({ created_at: { lt: "2026-09-01" } }), false);
  assert.equal(matches({ categories: { in: ["technology"] } }), true, "categories ignore case");
  assert.equal(matches({ metadata: { priority: { gte: 5 } } }), true);
  assert.equal(matches({ "metadata.source": { icontains: "EMA" } }), true);
  assert.equal(matches({ keywords: "preferring PNPM" }), true, "keywords stem and ignore case");
  assert.equal(
    matches({
      AND: [
        { OR: [{ user_id: "bob" }, { NOT: [{ run_id: "other" }] }] },
        { NOT: { metadata: { source: "chat" } } },
      ],
    }),
    true,
    "logic nests inside logic",
  );
  assert.equal(matches({ NOT: [{ user_id: "bob" }, { user_id: "alice" }] }), false);
});

test("filters say what's wrong", () => {
  assert.throws(() => parseFilter({ colour: "red" }), FilterError);
  assert.throws(() => parseFilter({ user_id: { like: "a" } }), FilterError);
  assert.throws(() => parseFilter({ OR: [] }), FilterError);
  assert.throws(() => parseFilter({ user_id: { in: "a" } }), FilterError);
});

test("tokens: stems meet, stopwords go", () => {
  assert.deepEqual(tokenize("The meetings were running"), ["meet", "run"]);
  assert.deepEqual(tokenize("studies"), ["study"]);
  assert.deepEqual(tokenize("class"), ["class"]);
});

test("the same fact in the same scope dedupes, in any spacing or case", () => {
  const key = dedupeKey("Likes  Tea", { userId: "a" });
  assert.equal(key, dedupeKey("likes tea", { userId: "a" }));
  assert.notEqual(key, dedupeKey("likes tea", { userId: "b" }));
});

test("ranking: keywords lift a semantic match and never sink one", () => {
  assert.ok(combineScores({ semantic: 0.8, bm25: 0, entity: 0 }) === 0.8);
  assert.ok(combineScores({ semantic: 0.8, bm25: 1, entity: 0 }) > 0.8);
  const ranked = rank(
    [
      { id: "weak", semantic: 0.05, keyword: 0, entity: 0 },
      { id: "plain", semantic: 0.7, keyword: 0, entity: 0 },
      { id: "both", semantic: 0.7, keyword: 8, entity: 0.5 },
      { id: "unembedded", semantic: null, keyword: 6, entity: 0 },
    ],
    { queryTerms: 2, limit: 10, threshold: 0.1, mode: "hybrid" },
  );
  assert.deepEqual(
    ranked.map((row) => row.id),
    ["both", "plain", "unembedded"],
    "the threshold gates similarity; a memory without a vector is still found by its words",
  );
});

test("local index: search, removal, snapshot", () => {
  const index = new LocalIndex("model", "q8", 2);
  index.put("a", 1, "tea from Kenya", [1, 0]);
  index.put("b", 2, "coffee from Brazil", [0, 1]);
  index.put("c", 1, "tea and coffee", [Math.SQRT1_2, Math.SQRT1_2]);
  assert.equal(index.semantic([1, 0], 1)[0]?.id, "a");
  assert.equal(index.keyword(["kenya"], 5)[0]?.id, "a");
  index.remove("a");
  assert.deepEqual(index.keyword(["kenya"], 5), []);
  assert.equal(index.semantic([1, 0], 1)[0]?.id, "c");

  const snapshot = index.toSnapshot("2026-11-02T00:00:00.000Z");
  const vectors = readSnapshot(snapshot, { modelId: "model", dtype: "q8", dimensions: 2 });
  assert.equal(vectors?.size, 2);
  assert.equal(vectors?.get("b")?.version, 2);
  assert.ok(Math.abs((vectors?.get("c")?.vector[0] ?? 0) - Math.SQRT1_2) < 0.01);
  assert.equal(readSnapshot(snapshot, { modelId: "other", dtype: "q8", dimensions: 2 }), null);
});

test("imports read every spelling, and count what has no text", () => {
  const parsed: ParsedImport = parseMemoryImport({
    count: 4,
    next: null,
    results: [
      { memory: "One", user_id: "u", session_id: "r", expiration_date: "2027-01-01" },
      { text: "Two", agentId: "a", created_at: 1_790_000_000 },
      { data: { memory: "Three" }, categories: ["misc"] },
      { id: "no-text" },
    ],
  });
  assert.equal(parsed.items.length, 3);
  assert.equal(parsed.skipped, 1);
  assert.equal(parsed.items[0]?.runId, "r");
  assert.equal(parsed.items[1]?.agentId, "a");
  assert.equal(parsed.items[2]?.text, "Three");
  assert.equal(parseMemoryImport(["plain"]).items[0]?.text, "plain");
  assert.equal(
    parseMemoryImport({ spaces: [{ namespaces: [{ memories: [{ memory: "Nested" }] }] }] }).items[0]
      ?.text,
    "Nested",
  );
});
