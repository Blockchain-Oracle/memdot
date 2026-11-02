// S10: a Python agent's whole journey, with a TypeScript owner on the other side. The owner uses this
// SDK, which is what the dashboard runs; the agent logs in with the Python CLI, reads what the owner
// uploaded, remembers and recalls in both modes, leaves things the owner opens here, and stops when
// it's revoked. Spends about 3 tPOT.
// Local stack: makes accounts. Usage: API_URL=… WEB_ORIGIN=… pnpm --filter @memdot/sdk journey:python
// A deployed service: LIVE=1 uses the demo account, and writes docs/evidence when everything passes.

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { MemDot, walletFromMnemonic } from "../src/index.js";

const baseUrl = process.env.API_URL ?? "http://localhost:8787";
const origin = process.env.WEB_ORIGIN ?? "http://localhost:3100";
const live = process.env.LIVE === "1";
const repo = (path: string) => new URL(`../../../${path}`, import.meta.url);
const PACKAGE = fileURLToPath(repo("python/memdot"));
const PYTHON = join(PACKAGE, ".venv/bin/python");
const SPACE_NAME = "Agent memory demo";

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : ` → ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
}

// A throwaway home: nothing here can touch the real ~/.memdot or ~/.claude.
const home = await mkdtemp(join(tmpdir(), "memdot-s10-"));
const agentEnv = {
  PATH: process.env.PATH,
  HOME: home,
  // The model comes down once, not once per run.
  HF_HOME: join(process.env.HOME as string, ".cache/huggingface"),
  MEMDOT_CREDENTIALS_DIR: home,
  MEMDOT_API_URL: baseUrl,
};

function python(args: string[], stdin?: string): Promise<{ exit: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      PYTHON,
      args,
      { cwd: PACKAGE, env: agentEnv, maxBuffer: 10_000_000 },
      (error, stdout, stderr) => {
        if (stderr.trim()) console.error(stderr.trim().slice(0, 2000));
        resolve({ exit: error ? (error.code as number) : 0, stdout });
      },
    );
    child.stdin?.end(stdin ?? "");
  });
}

const cli = async <T>(...args: string[]) => {
  const { exit, stdout } = await python(["-m", "memdot.cli", "--agent", ...args]);
  return { exit, out: JSON.parse(stdout || "{}") as { data: T; error?: { code: string } } };
};

/** The agent script's lines become checks here; its last line says what it left behind. */
function readChecks<T>(stdout: string): T {
  let result: T | undefined;
  for (const line of stdout.split("\n").filter(Boolean)) {
    const parsed = JSON.parse(line) as {
      check?: string;
      ok?: boolean;
      detail?: string;
      result?: T;
    };
    if (parsed.check) check(`Python: ${parsed.check}`, parsed.ok === true, parsed.detail);
    if (parsed.result) result = parsed.result;
  }
  return result as T;
}

// ── The owner, in TypeScript ────────────────────────────────────────────────────────────────────

const owner = MemDot.create({ baseUrl, origin, client: "journey-s10" });
let spaceId: string;
let privateNamespace: string;
let assistedNamespace: string;
if (live) {
  // The sign-in material stays outside git: context/ is never published.
  const accounts = JSON.parse(
    await readFile(repo("context/memdot/demo-accounts.local.json"), "utf8"),
  ) as { ownerRecoveryCode: string };
  await owner.account.signInWithRecoveryCode(accounts.ownerRecoveryCode);
  await owner.account.unlockWithRecoveryCode(accounts.ownerRecoveryCode);
  const space = (await owner.spaces.list()).find((row) => row.name === SPACE_NAME);
  if (!space) throw new Error("no demo space: run seed:memory first");
  spaceId = space.id;
  const namespaces = await owner.memories.namespaces(space.id);
  const assisted = namespaces.find((row) => row.mode === "assisted");
  const held = namespaces.find((row) => row.mode === "private");
  if (!assisted || !held) throw new Error("no demo namespaces: run seed:memory first");
  privateNamespace = held.id;
  assistedNamespace = assisted.id;
} else {
  await owner.account.create(walletFromMnemonic(generateMnemonic(wordlist)), { origin });
  const space = await owner.spaces.create({ name: SPACE_NAME });
  spaceId = space.id;
  const made = async (name: string, mode: "private" | "assisted") =>
    (await owner.memories.createNamespace({ spaceId, name, mode })).id;
  privateNamespace = await made("Agent's private memory", "private");
  assistedNamespace = await made("Agent's assisted memory", "assisted");
}

const stamp = randomBytes(3).toString("hex");
const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

const fileName = `handbook-${stamp}.txt`;
const fileBytes = new TextEncoder().encode(`Uploaded by the owner, ${stamp}: refunds take 5 days.`);
const uploaded = await owner.files.put(fileBytes, {
  spaceId,
  name: fileName,
  mime: "text/plain",
});
check("the owner uploads a file", uploaded.job.status === "finalized", uploaded.job);

// A new version takes the chunk path whatever its size: a manifest and its own blobs.
const chunkedBytes = randomBytes(2_000);
const chunked = await owner.files.put(chunkedBytes, {
  spaceId,
  name: fileName,
  mime: "text/plain",
  previousVersionId: uploaded.file.id,
});
check("and a new version of it, as chunks", chunked.job.status === "finalized", chunked.job);

const ownerFact = `Refunds for order ${stamp} go through Priya.`;
await owner.memories.add(ownerFact, {
  userId: "owner",
  namespaceId: privateNamespace,
  infer: false,
  wait: "chain",
});

// ── memdot login, from Python ───────────────────────────────────────────────────────────────────

const started = await cli<{ url: string; code: string }>("login", "--label", "Python journey");
check("the Python CLI starts a login", started.exit === 0, started);
const requestId = new URL(started.out.data.url).searchParams.get("request") as string;
const request = await owner.agents.claimConnect(requestId, started.out.data.code);
const agent = await owner.agents.approveConnect(request, {
  spaceIds: [spaceId],
  role: "read_write",
  namespaceId: privateNamespace,
  expiresInDays: 1,
});
const finished = await cli<{ connected: boolean; agent_id: string }>(
  "login",
  "--continue",
  "--wait",
  "20",
);
check("and collects its key", finished.out.data?.connected === true, finished);
const saved = JSON.parse(await readFile(join(home, "credentials.json"), "utf8"));
check("saved in the file the Node CLI reads", saved.agent?.id === agent.id && saved.api_key, null);

const whoami = await cli<{ reads_private: boolean }>("whoami");
check("it can read Private namespaces", whoami.out.data?.reads_private === true, whoami);

// ── The agent, in Python ────────────────────────────────────────────────────────────────────────

const { stdout, exit } = await python(
  ["scripts/journey_agent.py"],
  JSON.stringify({
    spaceId,
    privateNamespace,
    assistedNamespace,
    fileId: uploaded.file.id,
    fileName,
    fileSha: sha(fileBytes),
    chunkedFileId: chunked.file.id,
    chunkedFileSha: sha(chunkedBytes),
    ownerFact,
    ownerQuery: `who handles refunds for order ${stamp}`,
  }),
);
const left = readChecks<{
  fileId: string;
  fileBytes: string;
  memoryId: string;
  memory: string;
  memoryJob: string;
}>(stdout);
check("the agent's script finished", exit === 0 && Boolean(left), exit);

// ── And back: the owner opens what Python sealed ────────────────────────────────────────────────

const opened = await owner.files.get(left.fileId);
check(
  "the owner opens the file Python stored",
  new TextDecoder().decode(opened.data) === left.fileBytes,
  opened.name,
);
const memory = await owner.memories.get(left.memoryId);
check("and the memory Python wrote", memory.memory === left.memory, memory);
const found = await owner.memories.search(left.memory, { namespaceId: privateNamespace });
check("and finds it by meaning", found[0]?.id === left.memoryId, found[0]);
const verified = await owner.files.verify(left.fileId);
check("what Python stored verifies on V3", verified.ok, verified);

const [segment] = (await owner.files.list({ spaceId, kind: "segment", limit: 1 })).items;
const proof = segment?.cid ? await owner.proof.cid(segment.cid) : null;
const job = await owner.jobs.get(left.memoryJob);

// ── Stopped ─────────────────────────────────────────────────────────────────────────────────────

await owner.agents.revoke(agent);
const stopped = await python(["scripts/journey_agent.py", "--after-revoke"]);
readChecks(stopped.stdout);
const cliStopped = await cli("search", "refunds");
check("and the Python CLI says what to do", cliStopped.exit === 3, cliStopped);

// A live run tidies up, since a sponsored space is small.
if (live) {
  await owner.files.delete(chunked.file.id);
  await owner.files.delete(uploaded.file.id);
  await owner.files.delete(left.fileId);
}

if (live && failures === 0) {
  const at = new Date().toISOString();
  await writeFile(
    repo(`docs/evidence/s10-python-${at.slice(0, 10)}.json`),
    `${JSON.stringify(
      {
        stage: "S10",
        at,
        app: origin,
        api: baseUrl,
        spaceId,
        pythonWrites: {
          namespaceId: privateNamespace,
          jobId: left.memoryJob,
          cid: segment?.cid,
          txHash: job.txHash ?? proof?.firstStore?.txHash,
          block: job.block ?? proof?.firstStore?.block,
        },
      },
      null,
      2,
    )}\n`,
  );
  console.log("Evidence written to docs/evidence.");
}

await rm(home, { recursive: true, force: true });
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} checks failed.`);
await owner.close();
process.exit(failures === 0 ? 0 : 1);
