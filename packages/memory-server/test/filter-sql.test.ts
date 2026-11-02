import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFilter } from "@memdot/memory-engine";
import { PgDialect } from "drizzle-orm/pg-core";
import { AssistedKeys, scopeOf } from "../src/index.js";

const keys = new AssistedKeys("test-only-secret-test-only-secret");
const dialect = new PgDialect();

/** The WHERE clause a filter produces, with the namespace check as its first condition. */
function rendered(filter: unknown): string {
  const scope = scopeOf(keys, {
    folderId: "ns-1",
    filter: parseFilter(filter),
    at: new Date("2026-11-02T00:00:00Z"),
    showExpired: true,
  });
  return dialect.sqlToQuery(scope).sql;
}

/**
 * Parentheses depth at each top-level `or`: a bare `or` at depth 1 of the outer AND would let rows
 * from other namespaces through. This is the bug that let one account read another's memories.
 */
function hasEscapingOr(where: string): boolean {
  let depth = 0;
  for (let i = 0; i < where.length; i += 1) {
    const char = where[i];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (depth <= 1 && where.startsWith(" or ", i)) return true;
  }
  return false;
}

const FILTERS: [string, unknown][] = [
  ["nin on a scope", { user_id: { nin: ["x"] } }],
  ["nin on ids", { memory_ids: { nin: ["x"] } }],
  ["nin on a date", { created_at: { nin: ["2020-01-01"] } }],
  ["nin on metadata", { metadata: { team: { nin: ["x"] } } }],
  ["nin on categories", { categories: { nin: ["x"] } }],
  ["a single-child OR", { OR: [{ user_id: { nin: ["x"] } }] }],
  ["a single-child NOT", { NOT: [{ user_id: { nin: ["x"] } }] }],
  ["two OR branches", { OR: [{ user_id: "a" }, { user_id: "b" }] }],
  ["siblings", { user_id: { nin: ["x"] }, agent_id: { nin: ["y"] } }],
  ["deep nesting", { AND: [{ OR: [{ NOT: [{ run_id: { nin: ["x"] } }] }] }] }],
];

for (const [name, filter] of FILTERS) {
  test(`a filter can't reach past the namespace: ${name}`, () => {
    const where = rendered(filter);
    assert.ok(where.includes('"memories"."folder_id" = '), where);
    assert.equal(hasEscapingOr(where), false, where);
  });
}

test("the check above would catch the original bug", () => {
  assert.equal(hasEscapingOr('("memories"."folder_id" = $1 and x is null or not (y))'), true);
});
