import assert from "node:assert/strict";
import { test } from "node:test";
import { memoriesToCsv } from "../src/memories.js";

const line = (row: Record<string, unknown>) => memoriesToCsv([row]).split("\r\n")[1];

test("quotes, commas and line breaks stay inside their cell", () => {
  assert.equal(
    line({ id: "a", memory: 'said "hi", then\nleft' }),
    `a,"said ""hi"", then\nleft",,,,,,,,`,
  );
});

test("a cell that starts like a formula is marked as text", () => {
  for (const start of ["=", "+", "-", "@"]) {
    assert.equal(line({ memory: `${start}cmd` }), `,'${start}cmd,,,,,,,,`);
  }
  assert.equal(line({ memory: "=A1,B1" }), `,"'=A1,B1",,,,,,,,`);
});

test("lists and objects fit in one cell", () => {
  assert.equal(line({ categories: ["food", "travel"] }), ",,,,,food;travel,,,,");
  assert.equal(line({ metadata: { a: 1 } }), `,,,,,,"{""a"":1}",,,`);
});
