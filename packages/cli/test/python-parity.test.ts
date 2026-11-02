// The Python CLI's parity test reads the tree this CLI prints. If a command changes here, this fails
// until `pnpm --filter @memdot/sdk vectors:python` is run, and then Python's test says what to add.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("the tree Python checks against is current", () => {
  const cli = fileURLToPath(new URL("../src/index.ts", import.meta.url));
  const printed = execFileSync("tsx", [cli, "help", "--json"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  const current = JSON.parse(printed, (key, value) => (key === "default" ? undefined : value));
  const saved = JSON.parse(
    readFileSync(
      new URL("../../../python/memdot/tests/vectors/node-cli-help.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(current, saved);
});
