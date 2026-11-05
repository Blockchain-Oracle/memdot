// S13: everything added for the Pro features, in both modes, with a real webhook receiver on a public
// address. Chat, graph, categories, decay, profiles, Dream, schema and CSV exports, Copilot, webhooks
// and analytics. Needs `cloudflared`, and a model key in JOURNEY_MODEL_KEY, which it clears at the end.
// Local stack: RECOVERY_CODE_FILE=… pnpm --filter @memdot/sdk journey:pro
// A deployed service: LIVE=1 API_URL=… WEB_ORIGIN=… uses the demo account, and writes docs/evidence.

import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { MemDot, type Namespace, verifyWebhook } from "../src/index.js";

const baseUrl = process.env.API_URL ?? "http://localhost:8787";
const origin = process.env.WEB_ORIGIN ?? "http://localhost:3100";
const live = process.env.LIVE === "1";
const repo = (path: string) => new URL(`../../../${path}`, import.meta.url);
const MODELS =
  "gemini-3.1-flash-lite,gemini-2.5-flash-lite,gemini-3-flash-preview,gemini-2.5-flash";
const SPACE_NAME = "Agent memory demo";
const PERSON = "journey-person";
const OTHER_PERSON = "journey-other";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : ` → ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
}
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function recoveryCode(): Promise<string> {
  if (live) {
    const accounts = JSON.parse(
      await readFile(repo("context/memdot/demo-accounts.local.json"), "utf8"),
    ) as { ownerRecoveryCode: string };
    return accounts.ownerRecoveryCode;
  }
  return (await readFile(process.env.RECOVERY_CODE_FILE as string, "utf8")).trim();
}

const key = process.env.JOURNEY_MODEL_KEY;
if (!key) throw new Error("Set JOURNEY_MODEL_KEY.");

const memdot = MemDot.create({ baseUrl, origin, client: "journey-s13" });
const code = await recoveryCode();
await memdot.account.signInWithRecoveryCode(code);
await memdot.account.unlockWithRecoveryCode(code);

async function namespaceFor(mode: "assisted" | "private"): Promise<Namespace> {
  const name = `Pro features ${mode}`;
  const known = (await memdot.memories.namespaces()).find((row) => row.name === name);
  if (known) return known;
  const spaces = await memdot.spaces.list();
  const space = spaces.find((row) => row.name === SPACE_NAME) ?? spaces[0];
  if (!space) throw new Error("No space to work in.");
  return memdot.memories.createNamespace({ spaceId: space.id, name, mode });
}

async function walkMode(mode: "assisted" | "private") {
  console.log(`\n── ${mode} ──`);
  const namespace = await namespaceFor(mode);
  const namespaceId = namespace.id;
  await memdot.memories.reset(namespaceId);
  const record: Record<string, unknown> = { namespaceId };

  // Chat: recalled, streamed, kept. The next turn answers from what was kept.
  const bike = `zebra-${Date.now() % 100_000}`;
  const firstEvents: string[] = [];
  let kept: { id: string; memory: string | null }[] = [];
  let reply = "";
  for await (const event of memdot.memories.chat(
    [
      {
        role: "user",
        content: `My bicycle is called ${bike}, and Priya from Acme lent it to me. She works at Acme in Lagos.`,
      },
    ],
    { namespaceId, userId: PERSON },
  )) {
    firstEvents.push(event.type);
    if (event.type === "text") reply += event.text;
    if (event.type === "saved") kept = event.memories;
  }
  check("chat streams a reply", reply.length > 0);
  check("chat reports recall first", firstEvents[0] === "recalled", firstEvents.slice(0, 3));
  check("chat keeps the exchange", kept.length > 0, firstEvents.slice(-3));
  record.chatKept = kept.length;

  let recalled = 0;
  let answer = "";
  for await (const event of memdot.memories.chat(
    [{ role: "user", content: "What is my bicycle called?" }],
    { namespaceId, userId: PERSON, save: false },
  )) {
    if (event.type === "recalled") recalled = event.memories.length;
    if (event.type === "text") answer += event.text;
  }
  check("the next turn recalls it", recalled > 0);
  check("and answers from it", answer.toLowerCase().includes(bike), answer.slice(0, 80));

  // Graph.
  const graph = await memdot.memories.graph({ namespaceId });
  check("a graph comes from what's stored", graph.nodes.length >= 2, graph.nodes.length);
  check(
    "with typed relations",
    graph.edges.some((edge) => edge.relation),
    graph.edges.length,
  );
  record.graph = { nodes: graph.nodes.length, edges: graph.edges.length };

  // Categories.
  const categories = await memdot.memories.categories(namespaceId);
  const counted =
    categories.uncategorized + categories.categories.reduce((sum, row) => sum + row.count, 0);
  check("categories are counted", counted >= kept.length, categories);

  // Decay: a save that leaves it out keeps it, and turning it off is off.
  const settings = await memdot.memories.settings(namespaceId);
  const { customInstructions, categories: custom } = settings;
  await memdot.memories.setSettings(namespaceId, {
    customInstructions,
    categories: custom,
    decayHalfLifeDays: 30,
  });
  await memdot.memories.setSettings(namespaceId, { customInstructions, categories: custom });
  check(
    "decay survives a save that leaves it out",
    (await memdot.memories.settings(namespaceId)).decayHalfLifeDays === 30,
  );
  const leaning = await memdot.memories.search("bicycle", { namespaceId, threshold: 0 });
  check("search works with decay on", leaning.length > 0);
  await memdot.memories.setSettings(namespaceId, {
    customInstructions,
    categories: custom,
    decayHalfLifeDays: null,
  });
  check(
    "decay turns off",
    (await memdot.memories.settings(namespaceId)).decayHalfLifeDays === null,
  );

  // Profile: written, read back, and gone once what it rests on is forgotten.
  const profile = await memdot.memories.generateProfile(PERSON, { namespaceId });
  check("a profile is written", Boolean(profile.profile?.summary), profile);
  const again = await memdot.memories.profile(PERSON, { namespaceId });
  check("and read back", again.profile?.summary === profile.profile?.summary);

  // Dream: only ever within one person's memories, and applied by the ordinary calls.
  const facts: [string, string][] = [
    [OTHER_PERSON, "The office coffee machine is on the third floor."],
    [OTHER_PERSON, "The coffee machine in the office is on floor three."],
    [PERSON, "Standups are at 9:00 on Mondays."],
    [PERSON, "Standups moved to 10:30 on Mondays, starting this month."],
    [OTHER_PERSON, "Standups are at 9:00 on Mondays."],
  ];
  for (const [userId, text] of facts) {
    await memdot.memories.add(text, { namespaceId, userId, infer: false });
  }
  await sleep(mode === "assisted" ? 8000 : 0);
  // A model may see nothing worth changing, which is why the page has "Look again" too.
  let dream = await memdot.memories.dream({ namespaceId });
  if (dream.proposals.length === 0) dream = await memdot.memories.dream({ namespaceId });
  const owners = new Map<string, string | null>();
  for (const row of (await memdot.memories.list({ namespaceId, pageSize: 100 })).results) {
    owners.set(row.id, row.userId);
  }
  check("Dream proposes something", dream.proposals.length > 0, dream.proposals.length);
  check(
    "never across people",
    dream.proposals.every((proposal) => {
      const named = [...proposal.sources, ...(proposal.kept ? [proposal.kept] : [])];
      return new Set(named.map((id) => owners.get(id))).size === 1;
    }),
  );
  record.dream = dream.proposals.map((proposal) => proposal.kind);
  const first = dream.proposals[0];
  if (first) {
    await memdot.memories.applyDream(first);
    const left = new Set(
      (await memdot.memories.list({ namespaceId, pageSize: 100 })).results.map((row) => row.id),
    );
    const gone = first.kind === "merge" ? first.sources.slice(1) : first.sources;
    check(
      "applying it does what it said",
      first.kind === "synthesis" || gone.every((id) => !left.has(id)),
      first.kind,
    );
  }

  // Exports.
  const filled = await memdot.memories.exportToSchema({
    namespaceId,
    schema: {
      type: "object",
      properties: { facts: { type: "array", items: { type: "string" } } },
      required: ["facts"],
    },
  });
  check(
    "a schema gets filled",
    Array.isArray((filled.result as { facts?: unknown }).facts),
    filled.result,
  );
  const csv = await memdot.memories.exportCsv(namespaceId);
  const rows = csv.trim().split("\r\n");
  check("CSV has a row per memory", rows.length - 1 >= kept.length, rows.length);
  record.csvRows = rows.length - 1;

  // Copilot: uses its tools, and changes nothing by itself.
  const before = (await memdot.memories.list({ namespaceId, pageSize: 100 })).count;
  const question =
    "Which of these memories look out of date or duplicated? Propose forgetting one.";
  let toolCalls = 0;
  if (mode === "assisted") {
    const response = await memdot.memories.assistedCopilot(namespaceId, [
      { id: "q", role: "user", parts: [{ type: "text", text: question }] },
    ]);
    const stream = await response.text();
    toolCalls = (stream.match(/"tool-input-available"/g) ?? []).length;
    check("Copilot answers (server)", stream.includes('"text-delta"') || toolCalls > 0);
  } else {
    const result = await memdot.memories.privateCopilot(namespaceId, [
      { role: "user", content: question },
    ]);
    for await (const part of result.fullStream) if (part.type === "tool-call") toolCalls += 1;
    check("Copilot answers (on this device)", toolCalls > 0);
  }
  check("and uses its tools", toolCalls > 0);
  record.copilotToolCalls = toolCalls;
  const after = (await memdot.memories.list({ namespaceId, pageSize: 100 })).count;
  check("but changes nothing by itself", after === before, { before, after });

  // A forgotten memory takes the profile with it.
  await memdot.memories.deleteAll({ namespaceId, userId: PERSON });
  await sleep(1500);
  const dropped = await memdot.memories.profile(PERSON, { namespaceId });
  check("forgetting removes the profile", dropped.profile === null);
  return record;
}

async function walkWebhooks() {
  console.log("\n── webhooks ──");
  const received: { body: string; signature: string; event: string }[] = [];
  let answer = 200;
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      received.push({
        body,
        signature: String(request.headers["x-memdot-signature"]),
        event: String(request.headers["x-memdot-event"]),
      });
      response.writeHead(answer).end("ok");
    });
  }).listen(0);
  const { port } = server.address() as { port: number };
  const tunnel = spawn(
    "cloudflared",
    ["tunnel", "--url", `http://localhost:${port}`, "--no-autoupdate"],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const url = await new Promise<string>((found) => {
    const look = (data: Buffer) => {
      const match = String(data).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match) found(match[0]);
    };
    tunnel.stderr.on("data", look);
    tunnel.stdout.on("data", look);
  });
  // A new tunnel takes a moment to be reachable from elsewhere.
  await sleep(15_000);
  const arrived = async (event: string) => {
    for (let waited = 0; waited < 90; waited += 1) {
      const hit = received.find((row) => row.event === event);
      if (hit) return hit;
      await sleep(1000);
    }
    return null;
  };
  const record: Record<string, unknown> = {};
  const namespace = await namespaceFor("assisted");
  const webhook = await memdot.webhooks.create({
    name: "Journey receiver",
    url,
    events: ["memory.added"],
  });
  try {
    check("the secret comes back once", webhook.secret.startsWith("whsec_"));
    await memdot.webhooks.test(webhook.id);
    const test = await arrived("webhook.test");
    check("a test event arrives", Boolean(test));
    check("signed", Boolean(test && verifyWebhook(test.body, test.signature, webhook.secret)));

    const marker = `kettle-${Date.now()}`;
    await memdot.memories.add(`The ${marker} is blue.`, {
      namespaceId: namespace.id,
      userId: "journey-hook",
      infer: false,
    });
    const added = await arrived("memory.added");
    check("adding a memory sends an event", Boolean(added));
    check(
      "which verifies, and holds ids only",
      Boolean(
        added &&
          verifyWebhook(added.body, added.signature, webhook.secret) &&
          !added.body.includes(marker),
      ),
    );

    answer = 500;
    received.length = 0;
    await memdot.webhooks.test(webhook.id);
    await arrived("webhook.test");
    await sleep(3000);
    const failing = (await memdot.webhooks.deliveries(webhook.id))[0];
    check("a failing receiver is logged", failing?.response_status === 500, failing);
    check("and tried again", failing?.status === "pending", failing?.status);
    answer = 200;

    received.length = 0;
    const rotated = await memdot.webhooks.rotate(webhook.id);
    await memdot.webhooks.test(webhook.id);
    const after = await arrived("webhook.test");
    check(
      "a new secret verifies",
      Boolean(after && verifyWebhook(after.body, after.signature, rotated.secret)),
    );
    check(
      "the old one doesn't",
      Boolean(after && !verifyWebhook(after.body, after.signature, webhook.secret)),
    );
    record.deliveries = (await memdot.webhooks.deliveries(webhook.id)).length;
  } finally {
    await memdot.webhooks.delete(webhook.id);
    tunnel.kill();
    server.close();
  }
  return record;
}

const evidence: Record<string, unknown> = {
  stage: "S13",
  at: new Date().toISOString(),
  api: baseUrl,
  app: origin,
};
await memdot.memories.setModels({
  llm: { provider: "google", model: MODELS, api_key: key },
} as never);
await memdot.memories.setPrivateModel({ provider: "google", model: MODELS, apiKey: key });
try {
  const only = process.env.JOURNEY_ONLY?.split(",");
  const wants = (step: string) => !only || only.includes(step);
  if (wants("assisted")) evidence.assisted = await walkMode("assisted");
  if (wants("private")) evidence.private = await walkMode("private");
  if (wants("webhooks")) evidence.webhooks = await walkWebhooks();
  const analytics = await memdot.activity.analytics({ days: 7 });
  check(
    "analytics count the traffic",
    analytics.requests > 0 && analytics.requests_by_day.length === 7,
  );
  evidence.analytics = { requests: analytics.requests, memories: analytics.memories };
} finally {
  await memdot.memories.setModels({ llm: null } as never);
  await memdot.memories.setPrivateModel(null);
}

console.log(failures ? `\n${failures} failed` : "\nAll passed");
if (live && !failures) {
  const day = new Date().toISOString().slice(0, 10);
  evidence.passed = true;
  await writeFile(
    repo(`docs/evidence/s13-pro-features-${day}.json`),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
}
process.exit(failures ? 1 : 0);
