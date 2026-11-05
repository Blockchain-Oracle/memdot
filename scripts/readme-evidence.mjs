// Rewrites the README's evidence table from docs/evidence and the registry deployment, so every
// transaction listed there comes from a recorded run. Usage: pnpm evidence
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

const read = (path) => JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));
const latest = (prefix) =>
  readdirSync(new URL("../docs/evidence/", import.meta.url))
    .filter((name) => name.startsWith(prefix))
    .sort()
    .at(-1);
const latestSeed = latest("s07-seed-");
if (!latestSeed) throw new Error("no seed evidence yet: run the seed script first");
const latestSelfSigned = latest("s07-self-signed-");
const latestMemory = latest("s08-seed-");
const latestLive = latest("s08-live-");
const latestAgents = latest("s09-agents-");
const latestPython = latest("s10-python-");
const latestPlugin = latest("s11-plugin-");
const latestIntegrations = latest("s12-integrations-");

const seed = read(`docs/evidence/${latestSeed}`);
const selfSigned = latestSelfSigned ? read(`docs/evidence/${latestSelfSigned}`) : null;
const memory = latestMemory ? read(`docs/evidence/${latestMemory}`) : null;
const live = latestLive ? read(`docs/evidence/${latestLive}`) : null;
const agents = latestAgents ? read(`docs/evidence/${latestAgents}`) : null;
const python = latestPython ? read(`docs/evidence/${latestPython}`) : null;
const plugin = latestPlugin ? read(`docs/evidence/${latestPlugin}`) : null;
const integrations = latestIntegrations ? read(`docs/evidence/${latestIntegrations}`) : null;
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
    tx(seed.segment.txHash),
    block(seed.segment.block),
    cid(seed.segment.cid),
  ],
  [
    "Larger file stored (chunk + sealed manifest)",
    tx(seed.file.txHash),
    block(seed.file.block),
    cid(seed.file.cid),
  ],
  ...(seed.renew
    ? [
        [
          `Segment renewed: same CID, moved from block ${seed.renew.from.toLocaleString("en-US")}`,
          tx(seed.renew.txHash),
          block(seed.renew.block),
          cid(seed.renew.cid),
        ],
      ]
    : []),
  ...(selfSigned
    ? [
        [
          "File signed and paid for by the user's own wallet",
          tx(selfSigned.small.txHash),
          block(selfSigned.small.block),
          cid(selfSigned.small.cid),
        ],
        [
          "Larger file signed and paid for by the same wallet",
          tx(selfSigned.large.txHash),
          block(selfSigned.large.block),
          cid(selfSigned.large.cid),
        ],
      ]
    : []),
  ...(memory
    ? [
        [
          "An agent memory stored as an encrypted segment, written by MemDot's server",
          tx(memory.assisted.txHash),
          block(memory.assisted.block),
          cid(memory.assisted.cid),
        ],
        [
          "A Private namespace's search index, sealed on the device",
          tx(memory.private.snapshot.txHash),
          block(memory.private.snapshot.block),
          cid(memory.private.snapshot.cid),
        ],
      ]
    : []),
  ...(live
    ? [
        [
          "Facts a model distilled from a conversation, sealed and stored by the live service",
          tx(live.extracted.txHash),
          block(live.extracted.block),
          cid(live.extracted.cid),
        ],
      ]
    : []),
  ...(agents
    ? [
        [
          "A space's keys wrapped to a connected agent's own key",
          tx(agents.grant.txHash),
          block(agents.grant.block),
          cid(agents.grant.wrappedKeyCid),
        ],
        [
          "A Private memory written by that agent, with that key",
          tx(agents.agentMemory.txHash),
          block(agents.agentMemory.block),
          cid(agents.agentMemory.cid),
        ],
      ]
    : []),
  ...(python
    ? [
        [
          "A Private memory written from Python, which the TypeScript SDK then opened",
          tx(python.pythonWrites.txHash),
          block(python.pythonWrites.block),
          cid(python.pythonWrites.cid),
        ],
      ]
    : []),
  ...(plugin
    ? [
        [
          "A coding session's memories, saved by the agent plugin's hooks",
          tx(plugin.checkpoint.txHash),
          block(plugin.checkpoint.block),
          cid(plugin.checkpoint.cid),
        ],
      ]
    : []),
  ...(integrations?.n8n
    ? [
        [
          "A file encrypted inside an n8n workflow, read back and verified there",
          tx(integrations.n8n.file.txHash),
          block(integrations.n8n.file.block),
          cid(integrations.n8n.cid),
        ],
      ]
    : []),
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
  `Recorded by [\`docs/evidence/${latestSeed}\`](docs/evidence/${latestSeed})${latestSelfSigned ? `, [\`docs/evidence/${latestSelfSigned}\`](docs/evidence/${latestSelfSigned})` : ""}${latestMemory ? `, [\`docs/evidence/${latestMemory}\`](docs/evidence/${latestMemory})` : ""}${latestLive ? `, [\`docs/evidence/${latestLive}\`](docs/evidence/${latestLive})` : ""}${latestAgents ? `, [\`docs/evidence/${latestAgents}\`](docs/evidence/${latestAgents})` : ""}${latestPython ? ` and [\`docs/evidence/${latestPython}\`](docs/evidence/${latestPython})` : ""}${latestPlugin ? `, [\`docs/evidence/${latestPlugin}\`](docs/evidence/${latestPlugin})` : ""}. Registry transaction hashes are the EVM hashes Revive's RPC reports.`,
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
