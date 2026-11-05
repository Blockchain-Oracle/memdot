import assert from "node:assert/strict";
import { test } from "node:test";
import { buildGraph } from "../src/graph.js";

test("names that differ only in case and spacing are one thing", () => {
  const graph = buildGraph([
    { id: "a", entities: ["Acme Corp", "Priya"] },
    { id: "b", entities: ["acme  corp"] },
  ]);
  const acme = graph.nodes.find((node) => node.id === "acme corp");
  assert.equal(acme?.name, "Acme Corp");
  assert.deepEqual(acme?.memories, ["a", "b"]);
  assert.equal(graph.nodes.length, 2);
});

test("a stated relation keeps its direction and its words", () => {
  const graph = buildGraph([
    {
      id: "a",
      entities: ["Priya", "Acme"],
      relations: [{ source: "Priya", relation: "works at", target: "Acme" }],
    },
  ]);
  assert.deepEqual(graph.edges, [
    { source: "priya", target: "acme", relation: "works at", memories: ["a"] },
  ]);
});

test("being mentioned together is a weaker edge, with no direction", () => {
  const graph = buildGraph([
    { id: "a", entities: ["Tea", "Priya"] },
    { id: "b", entities: ["Priya", "Tea"] },
  ]);
  assert.deepEqual(graph.edges, [
    { source: "priya", target: "tea", relation: null, memories: ["a", "b"] },
  ]);
});

test("a long list of names isn't a thousand edges", () => {
  const entities = Array.from({ length: 30 }, (_, i) => `Thing ${i}`);
  const graph = buildGraph([{ id: "a", entities }]);
  assert.equal(graph.nodes.length, 30);
  assert.equal(graph.edges.length, 0);
});

test("blank names and blank relations are dropped, and nothing links to itself", () => {
  const graph = buildGraph([
    {
      id: "a",
      entities: ["  ", "Priya"],
      relations: [
        { source: "Priya", relation: "  ", target: "Acme" },
        { source: "Priya", relation: "is", target: "priya" },
      ],
    },
  ]);
  assert.equal(graph.edges.length, 0);
  assert.deepEqual(graph.nodes.map((node) => node.id).sort(), ["acme", "priya"]);
});

test("memories with neither give an empty graph", () => {
  assert.deepEqual(buildGraph([{ id: "a" }]), { nodes: [], edges: [] });
});
