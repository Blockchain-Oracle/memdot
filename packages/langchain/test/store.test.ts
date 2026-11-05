import assert from "node:assert/strict";
import { test } from "node:test";
import type { MemDot } from "@memdot/sdk";
import { MemDotStore } from "../src/index.js";

interface Row {
  id: string;
  memory: string;
  metadata: Record<string, unknown>;
  runId?: string;
  userId?: string;
  createdAt: string;
  updatedAt: string;
}

/** Enough of the memory API to hold a store, with the real rule that identical text in a scope is one row. */
function fakeClient(pageSize = 2) {
  const rows: Row[] = [];
  const at = new Date().toISOString();
  const matching = (filters?: Record<string, unknown>) => {
    const parts =
      (filters?.AND as Record<string, unknown>[] | undefined) ?? (filters ? [filters] : []);
    return rows.filter((row) =>
      parts.every((part) =>
        Object.entries(part).every(([field, wanted]) => {
          const have = row.metadata[field.replace("metadata.", "")];
          if (wanted === "*") return have !== undefined;
          if (wanted && typeof wanted === "object") {
            return String(have).includes((wanted as { contains: string }).contains);
          }
          return have === wanted;
        }),
      ),
    );
  };
  const memories = {
    async add(text: string, options: Omit<Row, "id" | "memory" | "createdAt" | "updatedAt">) {
      const twin = rows.find((row) => row.memory === text && row.runId === options.runId);
      if (twin) return { results: [], duplicates: 1, note: null };
      rows.push({
        id: `m${rows.length}`,
        memory: text,
        metadata: options.metadata,
        createdAt: at,
        updatedAt: at,
        ...(options.runId ? { runId: options.runId } : {}),
        ...(options.userId ? { userId: options.userId } : {}),
      });
      return { results: [{}], duplicates: 0, note: null };
    },
    async update(id: string, change: { text: string; metadata: Record<string, unknown> }) {
      const row = rows.find((candidate) => candidate.id === id) as Row;
      row.memory = change.text;
      row.metadata = change.metadata;
    },
    async delete(id: string) {
      rows.splice(
        rows.findIndex((row) => row.id === id),
        1,
      );
    },
    async list(options: { filters?: Record<string, unknown>; cursor?: string; pageSize: number }) {
      const size = Math.min(pageSize, options.pageSize);
      const start = Number(options.cursor ?? 0);
      const all = matching(options.filters);
      const next = start + size;
      return {
        results: all.slice(start, next),
        count: all.length,
        nextCursor: next < all.length ? String(next) : null,
      };
    },
    async search(_query: string, options: { filters?: Record<string, unknown> }) {
      return matching(options.filters).map((row) => ({ ...row, score: 0.5 }));
    },
  };
  return { rows, client: { memories } as unknown as MemDot };
}

test("the same text under two keys is two items", async () => {
  const { client } = fakeClient();
  const store = new MemDotStore(client);
  await store.put(["a"], "one", { text: "likes tea", rating: 1 });
  await store.put(["a"], "two", { text: "likes tea", rating: 2 });
  assert.equal((await store.get(["a"], "one"))?.value.rating, 1);
  assert.equal((await store.get(["a"], "two"))?.value.rating, 2);
});

test("a run id for each key, the same one Python makes", async () => {
  const { client, rows } = fakeClient();
  await new MemDotStore(client).put(["memories", "acme/alex"], "deploys", { text: "Fridays" });
  assert.equal(rows[0]?.runId, "store-208dc18e4a26c6631693e90a");
  assert.equal(rows[0]?.metadata.store_namespace, "memories/acme%2Falex");
});

test("a slash in a label doesn't make a different namespace", async () => {
  const { client } = fakeClient();
  const store = new MemDotStore(client);
  await store.put(["memories", "acme/alex"], "k", { text: "first" });
  await store.put(["memories", "acme", "alex"], "k", { text: "second" });
  assert.equal((await store.get(["memories", "acme/alex"], "k"))?.value.text, "first");
  assert.equal((await store.get(["memories", "acme", "alex"], "k"))?.value.text, "second");
  const found = await store.search(["memories", "acme"]);
  assert.deepEqual(
    found.map((item) => item.namespace),
    [["memories", "acme", "alex"]],
  );
});

test("nothing is assumed about who an item belongs to", async () => {
  const assumed = fakeClient();
  await new MemDotStore(assumed.client).put(["alex", "memories"], "k", { text: "x" });
  assert.equal(assumed.rows[0]?.userId, undefined);

  const told = fakeClient();
  await new MemDotStore(told.client, { userOf: ([user]) => user }).put(["alex", "memories"], "k", {
    text: "x",
  });
  assert.equal(told.rows[0]?.userId, "alex");
});

test("put again updates, and null deletes", async () => {
  const { client, rows } = fakeClient();
  const store = new MemDotStore(client);
  await store.put(["a"], "k", { text: "first" });
  await store.put(["a"], "k", { text: "second" });
  assert.equal(rows.length, 1);
  assert.equal((await store.get(["a"], "k"))?.value.text, "second");
  await store.delete(["a"], "k");
  assert.equal(await store.get(["a"], "k"), null);
});

test("search pages past what a filter throws away, and honours offset", async () => {
  const { client } = fakeClient(2);
  const store = new MemDotStore(client);
  for (let i = 0; i < 7; i += 1) await store.put(["a"], `k${i}`, { text: `item ${i}`, n: i });
  const big = await store.search(["a"], { filter: { n: { $gte: 5 } } });
  assert.deepEqual(big.map((item) => item.value.n).sort(), [5, 6]);
  const paged = await store.search(["a"], { limit: 2, offset: 5 });
  assert.equal(paged.length, 2);
});

test("filter operators mean what LangGraph says", async () => {
  const { client } = fakeClient();
  const store = new MemDotStore(client);
  await store.put(["a"], "k", { text: "x", n: 3, team: "pay", tags: ["a", "b"] });
  const matches = async (filter: Record<string, unknown>) =>
    (await store.search(["a"], { filter })).length === 1;
  assert.equal(await matches({ team: "pay" }), true);
  assert.equal(await matches({ team: { $ne: "pay" } }), false);
  assert.equal(await matches({ n: { $gt: 2 } }), true);
  assert.equal(await matches({ n: { $lt: 3 } }), false);
  assert.equal(await matches({ tags: ["a", "b"] }), true);
  assert.equal(await matches({ tags: { $eq: ["a"] } }), false);
});

test("listing namespaces takes labels apart again", async () => {
  const { client } = fakeClient();
  const store = new MemDotStore(client);
  await store.put(["memories", "acme/alex"], "k", { text: "x" });
  assert.deepEqual(await store.listNamespaces({}), [["memories", "acme/alex"]]);
});
