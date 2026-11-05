// S12: this node in a real n8n, in Docker, installed the way a person installs it, with no account and
// no clicking. Each step is its own n8n process, so what carries over can only have come from MemDot.
// Spends a little tPOT, a few model calls and one sponsored file.
//
// MEMDOT_API_KEY=… MEMDOT_AGENT_IDENTITY=… MEMDOT_API_URL=… MEMDOT_SPACE=… GOOGLE_GENERATIVE_AI_API_KEY=… \
//   pnpm --filter n8n-nodes-memdot journey

import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const N8N_IMAGE = process.env.N8N_IMAGE ?? "n8nio/n8n:2.46.4";
const MODEL = process.env.N8N_MODEL ?? "gemini-2.5-flash";
const PACKAGE = new URL("..", import.meta.url).pathname;
const MODEL_RETRIES = 4;
const MODEL_RETRY_MS = 65_000;
const SAVE_WAIT_MS = 120_000;
const POLL_MS = 3_000;

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name}.`);
  return value;
};
const apiKey = required("MEMDOT_API_KEY");
const identity = required("MEMDOT_AGENT_IDENTITY");
const apiUrl = required("MEMDOT_API_URL");
const spaceId = required("MEMDOT_SPACE");
const modelKey = required("GOOGLE_GENERATIVE_AI_API_KEY");
const namespaceId = process.env.MEMDOT_NAMESPACE?.trim() ?? "";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(
    `${ok ? "✓" : "✗"} ${label}${ok ? "" : ` → ${JSON.stringify(detail)?.slice(0, 600)}`}`,
  );
  if (!ok) failures += 1;
}

const run = (command: string, args: string[], cwd?: string) =>
  new Promise<{ code: number; output: string }>((resolve) => {
    execFile(
      command,
      args,
      { maxBuffer: 64_000_000, ...(cwd ? { cwd } : {}) },
      (error, stdout, stderr) => resolve({ code: error ? 1 : 0, output: `${stdout}${stderr}` }),
    );
  });

const work = await mkdtemp(join(tmpdir(), "memdot-n8n-"));
const data = join(work, "data");
const files = join(work, "files");
await mkdir(data);
await mkdir(files);
// n8n runs as its own user inside the container.
await chmod(data, 0o777);
await chmod(files, 0o755);

const packed = await run("npm", ["pack", "--silent", "--pack-destination", files], PACKAGE);
const tarball = packed.output.trim().split("\n").at(-1) as string;
check("it packs", tarball.endsWith(".tgz"), packed.output);

const credentials = [
  { id: "memdotCredential", name: "MemDot", type: "memDotApi", data: { apiKey, apiUrl, identity } },
  {
    id: "geminiCredential",
    name: "Gemini",
    type: "googlePalmApi",
    data: { host: "https://generativelanguage.googleapis.com", apiKey: modelKey },
  },
];
await writeFile(join(files, "credentials.json"), JSON.stringify(credentials));

interface WorkflowNode {
  name: string;
  type: string;
  parameters: Record<string, unknown>;
  credentials?: Record<string, { id: string; name: string }>;
}
interface Workflow {
  id: string;
  nodes: WorkflowNode[];
}

/** A shipped workflow with this run's credentials, ids and inputs put in. */
async function prepare(
  name: string,
  edit: (node: WorkflowNode) => void,
  runId: string,
): Promise<string> {
  const workflow = JSON.parse(
    await readFile(join(PACKAGE, "workflows", `${name}.json`), "utf8"),
  ) as Workflow;
  workflow.id = runId;
  for (const node of workflow.nodes) {
    if (node.credentials?.memDotApi) node.credentials.memDotApi.id = "memdotCredential";
    if (node.credentials?.googlePalmApi) node.credentials.googlePalmApi.id = "geminiCredential";
    if (node.type.startsWith("n8n-nodes-memdot.") && namespaceId && "resource" in node.parameters) {
      if (
        node.parameters.resource === "memory" &&
        ["add", "search"].includes(String(node.parameters.operation))
      ) {
        node.parameters.namespaceId = namespaceId;
      }
    }
    if (node.type.endsWith("memDotChatMemory") && namespaceId)
      node.parameters.namespaceId = namespaceId;
    if (node.type.endsWith("lmChatGoogleGemini")) node.parameters.modelName = `models/${MODEL}`;
    edit(node);
  }
  const file = `${runId}.json`;
  await writeFile(join(files, file), JSON.stringify([workflow]));
  return file;
}

interface RunResult {
  status: string | undefined;
  nodes: Record<string, { json?: Record<string, unknown>; error?: string; all: unknown[] }[]>;
  raw: string;
}

const SETUP = [
  "cd /home/node/.n8n && mkdir -p nodes && cd nodes",
  "[ -d node_modules/n8n-nodes-memdot ] || npm install /files/PACKED --omit=peer --ignore-scripts --no-audit --no-fund >/dev/null 2>&1",
  "cd / && n8n import:credentials --input=/files/credentials.json >/dev/null 2>&1",
].join(" && ");

/** One workflow through one new n8n process. */
async function execute(file: string, id: string): Promise<RunResult> {
  const script = `${SETUP.replace("PACKED", tarball)} && n8n import:workflow --input=/files/${file} >/dev/null 2>&1 && n8n execute --id=${id} --rawOutput`;
  const { output } = await run("docker", [
    "run",
    "--rm",
    "-e",
    "N8N_ENCRYPTION_KEY=memdot-journey",
    "-e",
    "N8N_DIAGNOSTICS_ENABLED=false",
    "-v",
    `${data}:/home/node/.n8n`,
    "-v",
    `${files}:/files:ro`,
    "--entrypoint",
    "sh",
    N8N_IMAGE,
    "-c",
    script,
  ]);
  const start = output.indexOf("{\n");
  if (start < 0) return { status: undefined, nodes: {}, raw: output.slice(-1500) };
  const execution = firstJson(output.slice(start)) as {
    status?: string;
    data: {
      resultData: {
        runData: Record<
          string,
          {
            error?: { message?: string };
            data?: Record<string, { json: Record<string, unknown> }[][]>;
          }[]
        >;
      };
    };
  };
  const nodes: RunResult["nodes"] = {};
  for (const [name, runs] of Object.entries(execution.data.resultData.runData)) {
    nodes[name] = runs.map((one) => {
      const items = Object.values(one.data ?? {})[0]?.[0] ?? [];
      return {
        ...(items[0]?.json ? { json: items[0].json } : {}),
        ...(one.error?.message ? { error: one.error.message } : {}),
        all: items.map((item) => item.json),
      };
    });
  }
  return { status: execution.status, nodes, raw: output.slice(-600) };
}

/** n8n prints log lines around the JSON, so read exactly one value from where it starts. */
function firstJson(text: string): unknown {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(text.slice(0, i + 1));
    }
  }
  throw new Error("n8n's output ended early.");
}

/** The free tier of a shared model limits by the minute, which says nothing about this node. */
async function executeWithModel(file: string, id: string): Promise<RunResult> {
  for (let attempt = 1; ; attempt += 1) {
    const result = await execute(file, id);
    const limited =
      result.status !== "success" &&
      /too many requests|overloaded|high demand/i.test(JSON.stringify(result.nodes));
    if (!limited || attempt === MODEL_RETRIES) return result;
    console.log(`  (the model is limiting requests; trying again in ${MODEL_RETRY_MS / 1000} s)`);
    await new Promise((resolve) => setTimeout(resolve, MODEL_RETRY_MS));
  }
}

const stamp = Date.now().toString(36);
const user = `n8n-${stamp}`;
const word = `zebra-${Math.floor(1000 + Math.random() * 9000)}`;
const anId = (tag: string) => `journey${tag}${stamp}`.slice(0, 16);
const evidence: Record<string, unknown> = {};

console.log("\n── Remember and search, with no model");
{
  const id = anId("b");
  const file = await prepare(
    "remember-and-search",
    (node) => {
      if (node.name === "Remember") {
        node.parameters.text = `Rosa waters the ferns on Tuesdays (${word})`;
        node.parameters.userId = user;
      }
      if (node.name === "Search") node.parameters.userId = user;
    },
    id,
  );
  const result = await execute(file, id);
  check("the workflow runs", result.status === "success", result.raw);
  check(
    "it remembers",
    Array.isArray(result.nodes.Remember?.[0]?.json?.results),
    result.nodes.Remember,
  );
  check(
    "and finds it by meaning",
    String(result.nodes.Search?.[0]?.json?.memory).includes(word),
    result.nodes.Search,
  );
}

console.log("\n── An AI Agent with MemDot in its memory slot");
{
  const message = (text: string, session: string) => (node: WorkflowNode) => {
    if (node.name === "Message") {
      node.parameters.jsonOutput = JSON.stringify({ chatInput: text, sessionId: session });
    }
    if (node.name === "MemDot Chat Memory") node.parameters.userId = user;
  };
  const answer = (result: RunResult) => String(result.nodes["AI Agent"]?.[0]?.json?.output ?? "");

  const firstId = anId("a1");
  const first = await executeWithModel(
    await prepare(
      "agent-with-memory",
      message(`Please remember this for later: my locker code word is ${word}.`, `one-${stamp}`),
      firstId,
    ),
    firstId,
  );
  check("the agent answers", first.status === "success", first.raw);
  check(
    "and the memory slot saved the turn",
    first.nodes["MemDot Chat Memory"]?.some((step) => step.json?.action === "saveContext") === true,
    first.nodes["MemDot Chat Memory"],
  );

  const sameId = anId("a2");
  const same = await executeWithModel(
    await prepare(
      "agent-with-memory",
      message("What did I just ask you to remember?", `one-${stamp}`),
      sameId,
    ),
    sameId,
  );
  check(
    "a new n8n process, same session: it follows the conversation",
    answer(same).includes(word),
    answer(same),
  );

  // The facts are distilled in the background, so wait until a new session could find them.
  const searchId = anId("s");
  const searchFile = await prepare(
    "remember-and-search",
    (node) => {
      if (node.name === "Remember") {
        node.parameters.text = `${user} is checking their locker`;
        node.parameters.userId = user;
      }
      if (node.name === "Search") {
        node.parameters.query = "locker code word";
        node.parameters.userId = user;
        node.parameters.limit = 5;
      }
    },
    searchId,
  );
  const deadline = Date.now() + SAVE_WAIT_MS;
  let distilled = false;
  while (!distilled && Date.now() < deadline) {
    const found = await execute(searchFile, searchId);
    distilled =
      found.nodes.Search?.[0]?.all.some((hit) => JSON.stringify(hit).includes(word)) === true;
    if (!distilled) await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  check("what it learned becomes a memory about the person", distilled);

  const otherId = anId("a3");
  const other = await executeWithModel(
    await prepare(
      "agent-with-memory",
      message("What is my locker code word?", `two-${stamp}`),
      otherId,
    ),
    otherId,
  );
  check(
    "a new session for the same person: it still knows",
    answer(other).includes(word),
    answer(other),
  );

  const strangerId = anId("a4");
  const stranger = await executeWithModel(
    await prepare(
      "agent-with-memory",
      (node) => {
        message("What is my locker code word?", `three-${stamp}`)(node);
        if (node.name === "MemDot Chat Memory") node.parameters.userId = `${user}-someone-else`;
      },
      strangerId,
    ),
    strangerId,
  );
  check(
    "someone else doesn't get it",
    stranger.status === "success" && !answer(stranger).includes(word),
    answer(stranger) || stranger.raw,
  );
}

console.log("\n── Memory as a tool the agent can call");
{
  const id = anId("t");
  const result = await executeWithModel(
    await prepare(
      "memory-as-a-tool",
      (node) => {
        if (node.name === "Search memory") node.parameters.userId = user;
      },
      id,
    ),
    id,
  );
  const reply = String(result.nodes["AI Agent"]?.[0]?.json?.output ?? "");
  check("the agent calls it", Boolean(result.nodes["Search memory"]?.length), result.raw);
  check("and answers from it", /tuesday/i.test(reply), reply);
}

console.log("\n── An encrypted file, on the chain and back");
{
  const id = anId("f");
  const body = `The cellar key is under brick ${word}.`;
  const result = await execute(
    await prepare(
      "encrypted-file",
      (node) => {
        if (node.name === "A note") node.parameters.jsonOutput = JSON.stringify({ body });
        if (node.name === "Encrypt and store") node.parameters.spaceId = spaceId;
      },
      id,
    ),
    id,
  );
  const stored = result.nodes["Encrypt and store"]?.[0]?.json;
  check("it encrypts and stores it", stored?.status === "finalized", result.raw);
  check(
    "it decrypts to the same text",
    result.nodes["Read it"]?.[0]?.json?.text === body,
    result.nodes["Read it"],
  );
  check(
    "the chain has it",
    result.nodes["Check the chain"]?.[0]?.json?.ok === true,
    result.nodes["Check the chain"],
  );
  check(
    "and it can be deleted",
    result.nodes["Delete it"]?.[0]?.json?.deleted === true,
    result.nodes["Delete it"],
  );
  evidence.file = { txHash: stored?.tx_hash, block: stored?.block, name: stored?.name };
  evidence.cid = (
    result.nodes["Check the chain"]?.[0]?.json?.blobs as { cid: string }[] | undefined
  )?.[0]?.cid;
}

console.log("\n── A key that doesn't work");
{
  const id = anId("x");
  const bad = [
    {
      ...credentials[0],
      id: "badCredential",
      name: "Bad",
      data: { apiKey: "md_not_a_real_key", apiUrl, identity },
    },
  ];
  await writeFile(join(files, "bad.json"), JSON.stringify(bad));
  const file = await prepare(
    "remember-and-search",
    (node) => {
      if (node.credentials?.memDotApi) node.credentials.memDotApi.id = "badCredential";
      if (node.name === "Remember") node.parameters.userId = user;
    },
    id,
  );
  const { output } = await run("docker", [
    "run",
    "--rm",
    "-e",
    "N8N_ENCRYPTION_KEY=memdot-journey",
    "-e",
    "N8N_DIAGNOSTICS_ENABLED=false",
    "-v",
    `${data}:/home/node/.n8n`,
    "-v",
    `${files}:/files:ro`,
    "--entrypoint",
    "sh",
    N8N_IMAGE,
    "-c",
    `n8n import:credentials --input=/files/bad.json >/dev/null 2>&1; n8n import:workflow --input=/files/${file} >/dev/null 2>&1; n8n execute --id=${id} --rawOutput`,
  ]);
  check("the run says so in words", output.includes("MemDot refused this key"), output.slice(-500));
}

await rm(work, { recursive: true, force: true });
if (failures) {
  console.log(`\n${failures} checks failed.`);
  process.exit(1);
}
console.log(`\nEverything held. ${JSON.stringify(evidence)}`);
