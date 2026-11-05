import assert from "node:assert/strict";
import { test } from "node:test";
import { applyDecay, decayFactor } from "../src/scoring.js";

const now = new Date("2026-11-05T00:00:00Z");
const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);

test("a memory halves towards the floor, and never reaches zero", () => {
  assert.equal(decayFactor(now, now, 30), 1);
  assert.ok(Math.abs(decayFactor(daysAgo(30), now, 30) - 0.65) < 1e-9);
  assert.ok(Math.abs(decayFactor(daysAgo(30_000), now, 30) - 0.3) < 1e-9);
});

test("a touch in the future counts as now", () => {
  assert.equal(decayFactor(daysAgo(-5), now, 30), 1);
});

test("what's in use overtakes a slightly better match that's gone cold", () => {
  const touched: Record<string, Date> = { cold: daysAgo(120), warm: daysAgo(1) };
  const ordered = applyDecay(
    [
      { id: "cold", score: 0.9 },
      { id: "warm", score: 0.8 },
    ],
    (id) => touched[id] as Date,
    { now, halfLifeDays: 30, limit: 10 },
  );
  assert.deepEqual(
    ordered.map((hit) => hit.id),
    ["warm", "cold"],
  );
});

test("a much better old match still beats a poor recent one", () => {
  const touched: Record<string, Date> = { old: daysAgo(3650), new: now };
  const ordered = applyDecay(
    [
      { id: "new", score: 0.2 },
      { id: "old", score: 0.9 },
    ],
    (id) => touched[id] as Date,
    { now, halfLifeDays: 30, limit: 1 },
  );
  assert.deepEqual(
    ordered.map((hit) => hit.id),
    ["old"],
  );
});
