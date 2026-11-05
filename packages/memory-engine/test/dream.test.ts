import assert from "node:assert/strict";
import { test } from "node:test";
import { type DreamProposal, usableProposals } from "../src/extract.js";

const memories = [
  { id: "a", text: "x", createdAt: "2026-11-01", userId: "ama" },
  { id: "b", text: "x", createdAt: "2026-11-02", userId: "ama" },
  { id: "c", text: "x", createdAt: "2026-11-03", userId: "kofi" },
  { id: "d", text: "x", createdAt: "2026-11-04", agentId: "bot" },
];
const merge = (...sources: string[]): DreamProposal => ({
  kind: "merge",
  sources,
  kept: null,
  text: "together",
  reason: "same",
});

test("memories about one person can be merged", () => {
  assert.equal(usableProposals([merge("a", "b")], memories).length, 1);
});

test("memories about different people, or a person and an agent, can't", () => {
  assert.equal(usableProposals([merge("a", "c")], memories).length, 0);
  assert.equal(usableProposals([merge("a", "d")], memories).length, 0);
  const crossing: DreamProposal = {
    kind: "supersede",
    sources: ["a"],
    kept: "c",
    text: null,
    reason: "newer",
  };
  assert.equal(usableProposals([crossing], memories).length, 0);
});

test("unknown ids, reused ids and incomplete proposals are dropped", () => {
  assert.equal(usableProposals([merge("a", "zzz")], memories).length, 0);
  assert.equal(usableProposals([merge("a", "a")], memories).length, 0);
  assert.equal(usableProposals([merge("a")], memories).length, 0);
  assert.equal(usableProposals([{ ...merge("a", "b"), text: " " }], memories).length, 0);
  assert.equal(usableProposals([merge("a", "b"), merge("a", "b")], memories).length, 1);
});
