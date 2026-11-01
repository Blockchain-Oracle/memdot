// Rewrites the README's evidence table from docs/evidence and the registry deployment, so every
// transaction listed there comes from a recorded run. Usage: pnpm evidence
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
const latestSeed = readdirSync(new URL("../docs/evidence/", import.meta.url))
  .filter((name) => name.startsWith("s07-seed-"))
  .sort()
  .at(-1);
if (!latestSeed) throw new Error("no seed evidence yet: run the seed script first");

const seed = read(`docs/evidence/${latestSeed}`);
const registry = read("packages/contracts/deployments/portaldot-v3.json");
const block = (n) => `[#${n.toLocaleString("en-US")}](${seed.app}/proof/block/${n})`;
const tx = (hash) => `[\`${hash.slice(0, 10)}…${hash.slice(-6)}\`](${seed.app}/proof/tx/${hash})`;
const cid = (value) =>
  `[\`${value.slice(0, 12)}…${value.slice(-6)}\`](${seed.app}/proof/cid/${value})`;
const LABEL = {
  RegisterKey: "Sharing key registered",
  CreateSpace: "Space created",
  AddObjects: "Object recorded",
  Grant: "Space shared",
};

const rows = [
  [
    "Registry deployed",
    `\`${registry.txHash.slice(0, 10)}…${registry.txHash.slice(-6)}\``,
    block(registry.block),
    `\`${registry.address}\``,
  ],
  [
    "Three files stored in one segment",
    tx(seed.store.segment.txHash),
    block(seed.store.segment.block),
    cid(seed.store.segment.cid),
  ],
  [
    "Larger file stored (chunk + sealed manifest)",
    tx(seed.store.file.txHash),
    block(seed.store.file.block),
    cid(seed.store.file.cid),
  ],
  [
    "Segment renewed: same CID, new location",
    tx(seed.renew.txHash),
    block(seed.renew.block),
    cid(seed.renew.cid),
  ],
  ...seed.records.map((record) => [
    `Registry record: ${LABEL[record.action] ?? record.action}`,
    `\`${record.txHash.slice(0, 10)}…${record.txHash.slice(-6)}\``,
    block(record.block),
    `[view](${seed.app}/proof/registry)`,
  ]),
];
const table = [
  "| What happened | Transaction | Block | Check it |",
  "|---|---|---|---|",
  ...rows.map((row) => `| ${row.join(" | ")} |`),
  "",
  `Recorded by [\`docs/evidence/${latestSeed}\`](docs/evidence/${latestSeed}) on ${seed.at.slice(0, 10)}. Registry transaction hashes are the EVM hashes Revive's RPC reports.`,
].join("\n");

const readmeUrl = new URL("../README.md", import.meta.url);
const readme = readFileSync(readmeUrl, "utf8");
const updated = readme.replace(
  /<!-- evidence:start -->[\s\S]*<!-- evidence:end -->/,
  `<!-- evidence:start -->\n${table}\n<!-- evidence:end -->`,
);
if (updated === readme && !readme.includes("<!-- evidence:start -->")) {
  throw new Error("the README has no evidence markers");
}
writeFileSync(readmeUrl, updated);
console.log(`Wrote ${rows.length} rows from ${latestSeed}`);
