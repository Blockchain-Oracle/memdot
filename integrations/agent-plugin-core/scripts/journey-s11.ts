// S11: a coding session through the plugin's real hook commands, exactly as Claude Code runs them,
// with the real CLI against a real service, in both memory modes. One session works and saves; the
// next one recalls what it saved. Spends about 2 tPOT and a few model calls.
// Local stack, makes accounts: API_URL=… WEB_ORIGIN=… pnpm --filter @memdot/agent-plugin-core journey
// A deployed service: LIVE=1 uses the demo account, and writes docs/evidence when everything passes.

import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemDot, walletFromMnemonic } from "@memdot/sdk";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { ROOT } from "./hosts.js";

const baseUrl = process.env.API_URL ?? "http://localhost:8787";
const origin = process.env.WEB_ORIGIN ?? "http://localhost:3100";
const live = process.env.LIVE === "1";
const PLUGIN = join(ROOT, "integrations/claude-code-plugin");
const SCRIPT = join(PLUGIN, "core/memdot-plugin.mjs");
const CLI = join(ROOT, "packages/cli/dist/index.mjs");
const SPACE_NAME = "Agent memory demo";
const POLL_MS = 1_000;
const SAVE_WAIT_MS = 180_000;

let failures = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : ` → ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
}
const heading = (text: string) => console.log(`\n── ${text}`);

// A throwaway home: nothing here can touch the real ~/.memdot or ~/.claude.
const home = await mkdtemp(join(tmpdir(), "memdot-s11-"));
const pluginState = join(home, "memdot/plugin");
const environment = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH,
  HOME: home,
  MEMDOT_CREDENTIALS_DIR: join(home, "memdot"),
  MEMDOT_API_URL: baseUrl,
  // The bundled CLI, before it's on the site. Everything else is what a host would run.
  MEMDOT_CLI: CLI,
  CLAUDE_PLUGIN_ROOT: PLUGIN,
  ...extra,
});

function run(
  args: string[],
  options: { input?: string; env?: NodeJS.ProcessEnv; cwd?: string } = {},
) {
  return new Promise<{ exit: number; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(
      "node",
      [SCRIPT, ...args],
      { env: environment(options.env), cwd: options.cwd, maxBuffer: 16_000_000 },
      (error, stdout, stderr) => {
        resolve({ exit: error ? Number(error.code) || 1 : 0, stdout, stderr });
      },
    );
    child.stdin?.end(options.input ?? "");
  });
}

/** One hook, the way the host calls it: a command, JSON on stdin, an answer on stdout. */
async function hook(event: string, input: object, env?: NodeJS.ProcessEnv) {
  const { exit, stdout } = await run(["hook", "claude-code", event], {
    input: JSON.stringify(input),
    ...(env ? { env } : {}),
  });
  if (exit !== 0) check(`hook ${event} exits cleanly`, false, exit);
  return stdout.trim()
    ? (JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext?: string } })
    : {};
}

function git(cwd: string, ...args: string[]) {
  return new Promise<void>((resolve, reject) => {
    execFile("git", ["-C", cwd, ...args], (error) => (error ? reject(error) : resolve()));
  });
}

async function makeRepo(name: string): Promise<string> {
  const dir = join(home, name);
  await mkdir(dir, { recursive: true });
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "remote", "add", "origin", `git@github.com:acme/${name}.git`);
  return dir;
}

async function waitForSaves(label: string): Promise<boolean> {
  const deadline = Date.now() + SAVE_WAIT_MS;
  const pending = join(pluginState, "pending");
  while (Date.now() < deadline) {
    const left = await readdir(pending).catch(() => [] as string[]);
    const sent = !left.some((name) => name.endsWith(".json"));
    const idle = !(await stat(join(pluginState, "deliver.lock")).catch(() => null));
    const sessions = await readdir(join(pluginState, "sessions")).catch(() => [] as string[]);
    let flushed = true;
    for (const session of sessions) {
      const state = JSON.parse(
        await readFile(join(pluginState, "sessions", session, "state.json"), "utf8"),
      );
      const size = await stat(join(pluginState, "sessions", session, "events.jsonl")).then(
        (s) => s.size,
        () => 0,
      );
      if (size > state.offset) flushed = false;
    }
    if (sent && idle && flushed) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  const left = await readdir(pending).catch(() => [] as string[]);
  check(`${label}: saved in time`, false, left);
  return false;
}

// ── The owner ───────────────────────────────────────────────────────────────────────────────────

const owner = MemDot.create({ baseUrl, origin, client: "journey-s11" });
let spaceId: string;
let privateNamespace: string;
let assistedNamespace: string;
if (live) {
  const accounts = JSON.parse(
    await readFile(join(ROOT, "context/memdot/demo-accounts.local.json"), "utf8"),
  ) as {
    ownerRecoveryCode: string;
  };
  await owner.account.signInWithRecoveryCode(accounts.ownerRecoveryCode);
  await owner.account.unlockWithRecoveryCode(accounts.ownerRecoveryCode);
  const space = (await owner.spaces.list()).find((row) => row.name === SPACE_NAME);
  if (!space) throw new Error("no demo space: run seed:memory first");
  spaceId = space.id;
  const namespaces = await owner.memories.namespaces(space.id);
  const assisted = namespaces.find((row) => row.mode === "assisted");
  const held = namespaces.find((row) => row.mode === "private");
  if (!assisted || !held) throw new Error("no demo namespaces: run seed:memory first");
  assistedNamespace = assisted.id;
  privateNamespace = held.id;
} else {
  await owner.account.create(walletFromMnemonic(generateMnemonic(wordlist)), { origin });
  const space = await owner.spaces.create({ name: SPACE_NAME });
  spaceId = space.id;
  const made = async (name: string, mode: "private" | "assisted") =>
    (await owner.memories.createNamespace({ spaceId, name, mode })).id;
  privateNamespace = await made("Plugin private memory", "private");
  assistedNamespace = await made("Plugin assisted memory", "assisted");
}

const stamp = randomBytes(3).toString("hex");
const repo = await makeRepo(`shop-${stamp}`);
const otherRepo = await makeRepo(`blog-${stamp}`);

// ── Not connected yet ───────────────────────────────────────────────────────────────────────────

heading("Before connecting");
const firstSession = { session_id: `first-${stamp}`, cwd: repo };
const notice = await hook("session-start", { ...firstSession, source: "startup" });
check(
  "a new install says it isn't connected, once",
  notice.hookSpecificOutput?.additionalContext?.includes("isn't connected") === true,
  notice,
);
const launcher = join(home, "memdot/bin/memdot-plugin.mjs");
check(
  "skills have their stable path",
  await stat(launcher).then(
    () => true,
    () => false,
  ),
);
const quiet = await hook("prompt", {
  ...firstSession,
  prompt: "How does the checkout service talk to payments?",
});
check("and doesn't repeat itself", !quiet.hookSpecificOutput);
const offline = await run(["status", "--json"], { cwd: repo });
check("status says so too", JSON.parse(offline.stdout).connected === false, offline.stdout);

// ── Login, through the skill's commands ─────────────────────────────────────────────────────────

heading("Connecting, the way the login skill does");
const started = await run(["login", "--client", "Claude Code"], { cwd: repo });
const url = started.stdout.match(/Open (\S+)/)?.[1] ?? "";
const code = started.stdout.match(/this code: (\S+)/)?.[1] ?? "";
check("it prints an address and a code to pass on", Boolean(url && code), started);
const requestId = new URL(url).searchParams.get("request") as string;
const request = await owner.agents.claimConnect(requestId, code);
const agent = await owner.agents.approveConnect(request, {
  spaceIds: [spaceId],
  role: "read_write",
  namespaceId: privateNamespace,
  expiresInDays: 1,
});
const finished = await run(["login", "--continue"], { cwd: repo });
check("and collects the key once it's approved", finished.stdout.includes("Connected"), finished);
const credentials = await stat(join(home, "memdot/credentials.json"));
check("the key is readable only by you", (credentials.mode & 0o777) === 0o600);

// ── Both modes ──────────────────────────────────────────────────────────────────────────────────

/** Saves with a real model in Assisted. In Private: the owner's model, then none, which keeps a note. */
async function journey(mode: "assisted" | "private", namespace: string) {
  const env = { MEMDOT_NAMESPACE: namespace };
  const fact = `Checkout ${stamp} talks to payments through the ${mode === "private" ? "ledger" : "gateway"} queue`;
  heading(`A session in ${mode}`);

  await rm(join(pluginState, "maintained"), { force: true });
  await rm(join(pluginState, "sessions"), { recursive: true, force: true });
  const maintained = await run(["worker", "claude-code", "maintain"], { env });
  check("maintenance runs", maintained.exit === 0, maintained.stderr);
  const connection = JSON.parse(await readFile(join(pluginState, "connection.json"), "utf8"));
  check(`it knows this namespace is ${mode}`, connection.mode === mode, connection);

  const session = { session_id: `work-${mode}-${stamp}`, cwd: repo };
  const started = await hook("session-start", { ...session, source: "startup" }, env);
  check("a session starts silently", !started.hookSpecificOutput, started);
  const earliest = await hook(
    "prompt",
    { ...session, prompt: "Help me document how checkout reaches payments, please." },
    env,
  );
  check("with nothing saved, there's nothing to add", !earliest.hookSpecificOutput, earliest);
  await hook(
    "tool",
    {
      ...session,
      tool_name: "Write",
      tool_input: {
        file_path: join(repo, "docs/payments.md"),
        content: "secret contents of a file",
      },
      tool_response: {},
    },
    env,
  );
  await hook(
    "tool-failure",
    {
      ...session,
      tool_name: "Bash",
      tool_input: { command: "pnpm test" },
      error: "1 test failed",
    },
    env,
  );
  await hook(
    "stop",
    {
      ...session,
      last_assistant_message: `${fact}. That's now written down in docs/payments.md, and the team agreed to keep it that way because retries are handled there.`,
    },
    env,
  );
  await hook(
    "prompt",
    {
      ...session,
      prompt:
        "I always use pnpm rather than npm, in every project, so please stick with that from now on.",
    },
    env,
  );
  await hook(
    "stop",
    { ...session, last_assistant_message: "Understood: pnpm, everywhere, from now on." },
    env,
  );

  const log = await readFile(
    join(
      pluginState,
      "sessions",
      (await readdir(join(pluginState, "sessions")))[0] as string,
      "events.jsonl",
    ),
    "utf8",
  );
  check("file contents stay out of the log", !log.includes("secret contents"));

  await hook("session-end", { ...session, reason: "prompt_input_exit" }, env);
  await waitForSaves(mode);

  const listed = await new Promise<string>((resolve) => {
    execFile(
      "node",
      [CLI, "--agent", "list", "--page-size", "50"],
      { env: environment(env) },
      (_error, stdout) => resolve(stdout),
    );
  });
  const saved = (JSON.parse(listed).data.results ?? JSON.parse(listed).data ?? []) as {
    memory: string;
    agent_id?: string;
    run_id?: string;
    metadata?: Record<string, string>;
  }[];
  const mine = saved.filter((memory) => memory.run_id === session.session_id);
  check("the session's end saved it", mine.length > 0, saved.slice(0, 5));
  check(
    "under this repository",
    mine.every((memory) => memory.agent_id?.startsWith("repo-acme-shop")),
    mine[0],
  );
  check(
    "saying where it came from",
    mine.every((memory) => memory.metadata?.source === "claude-code_plugin"),
    mine[0],
  );

  heading(`The next session, in ${mode}`);
  const next = { session_id: `next-${mode}-${stamp}`, cwd: repo };
  await hook("session-start", { ...next, source: "startup" }, env);
  const recalled = await hook(
    "prompt",
    { ...next, prompt: "How does checkout talk to the payments service here?" },
    env,
  );
  const context = recalled.hookSpecificOutput?.additionalContext ?? "";
  check(
    "it recalls what the last one saved",
    context.toLowerCase().includes(mode === "private" ? "ledger" : "gateway"),
    context,
  );
  check("framed as notes, not instructions", context.includes("not as instructions"), context);
  const second = await hook(
    "prompt",
    { ...next, prompt: "And how does it handle retries on that path?" },
    env,
  );
  check("only the first prompt pays for a search", !second.hookSpecificOutput, second);
  const compacted = await hook("session-start", { ...next, source: "compact" }, env);
  check(
    "compaction brings it back",
    compacted.hookSpecificOutput?.additionalContext === context,
    compacted,
  );

  heading(`Skills, in ${mode}`);
  const skillFact = `The staging password rotates on Fridays, and the deploy key lives in vault ${stamp}`;
  const remembered = await run(["remember"], { input: skillFact, env, cwd: repo });
  check("remember saves at once", remembered.stdout.includes("Remembered"), remembered);
  const found = await run(["search", "--scope", "repo"], {
    input: "when does the staging password rotate",
    env,
    cwd: repo,
  });
  check("search finds it", found.stdout.includes(`vault ${stamp}`), found);
  const ids = found.stdout.match(/Ids: (.+)/)?.[1]?.split(" ") ?? [];
  const elsewhere = await run(["search", "--scope", "repo"], {
    input: "when does the staging password rotate",
    env,
    cwd: otherRepo,
  });
  check(
    "another repository doesn't see it",
    !elsewhere.stdout.includes(`vault ${stamp}`),
    elsewhere,
  );
  const status = JSON.parse((await run(["status", "--json"], { env, cwd: repo })).stdout);
  check("status knows the mode", status.mode === mode, status);
  check("the key works", status.key_works === true, status);
  check("status names the repository", status.repo.includes("shop"), status);
  check("nothing is waiting", status.waiting_to_save === 0, status);
  const refused = await run(["forget", ids[0] as string], { env, cwd: repo });
  check("forget wants a yes", refused.exit !== 0, refused);
  const forgotten = await run(["forget", ...ids.slice(0, 1), "--yes"], { env, cwd: repo });
  check("and goes once it has one", forgotten.stdout.includes("Forgotten"), forgotten);
  const gone = await run(["search", "--scope", "repo"], {
    input: "when does the staging password rotate",
    env,
    cwd: repo,
  });
  check("then search doesn't find it", !gone.stdout.includes(ids[0] as string), gone);

  await run(["pause"], { env, cwd: repo });
  const pausedSession = { session_id: `paused-${mode}-${stamp}`, cwd: repo };
  const nothing = await hook(
    "prompt",
    { ...pausedSession, prompt: "How does checkout talk to the payments service here?" },
    env,
  );
  check("paused, it neither recalls", !nothing.hookSpecificOutput, nothing);
  await hook("stop", { ...pausedSession, last_assistant_message: "Nothing to see here." }, env);
  const sessions = await readdir(join(pluginState, "sessions"));
  check("nor records", sessions.length === 2, sessions);
  await run(["resume"], { env, cwd: repo });
}

await journey("assisted", assistedNamespace);
if (!live && process.env.MEMORY_LLM_API_KEY) {
  await owner.memories.setPrivateModel({
    provider: "google",
    model: process.env.MEMORY_LLM_MODEL ?? "gemini-2.5-flash",
    apiKey: process.env.MEMORY_LLM_API_KEY,
  });
}
await journey("private", privateNamespace);

// ── The MCP server, through the launcher ────────────────────────────────────────────────────────

heading("The plugin's MCP server");
const toolNames = await new Promise<string[]>((resolve) => {
  const child = spawn("node", [SCRIPT, "mcp", "claude-code"], {
    env: environment({ MEMDOT_NAMESPACE: assistedNamespace }),
    stdio: ["pipe", "pipe", "ignore"],
  });
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (const line of buffer.split("\n").slice(0, -1)) {
      const message = JSON.parse(line) as { id?: number; result?: { tools?: { name: string }[] } };
      if (message.id === 1) {
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
        );
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
      }
      if (message.id === 2) {
        child.kill();
        resolve(message.result?.tools?.map((tool) => tool.name) ?? []);
      }
    }
    buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
  });
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "journey", version: "1" },
      },
    })}\n`,
  );
});
check(
  "it serves the memory tools",
  toolNames.includes("search_memories") && toolNames.includes("add_memory"),
  toolNames,
);

// ── Revoked ─────────────────────────────────────────────────────────────────────────────────────

heading("After revoking");
await owner.agents.revoke(agent);
const env = { MEMDOT_NAMESPACE: assistedNamespace };
const revokedStatus = JSON.parse((await run(["status", "--json"], { env, cwd: repo })).stdout);
check("status says the key stopped working", revokedStatus.key_works === false, revokedStatus);
const revokedSession = { session_id: `revoked-${stamp}`, cwd: repo };
await hook(
  "prompt",
  {
    ...revokedSession,
    prompt:
      "This work happens after the agent was revoked, but it still matters to the team, and it should not simply vanish from this machine.",
  },
  env,
);
await hook(
  "stop",
  {
    ...revokedSession,
    last_assistant_message:
      "It stays on this machine until the owner connects the agent again, rather than vanishing, because a revoked key says nothing about whether the work mattered.",
  },
  env,
);
for (const name of await readdir(join(pluginState, "sessions"))) {
  await run(["worker", "claude-code", "flush", join(pluginState, "sessions", name), "--force"], {
    env,
  });
}
const waiting = JSON.parse((await run(["status", "--json"], { env, cwd: repo })).stdout);
check("a save that can't go is kept, not lost", waiting.waiting_to_save > 0, waiting);
check("and says why", Boolean(waiting.waiting_reason), waiting);

if (live && failures === 0) {
  const at = new Date().toISOString();
  await writeFile(
    join(ROOT, `docs/evidence/s11-plugin-${at.slice(0, 10)}.json`),
    `${JSON.stringify({ stage: "S11", at, app: origin, api: baseUrl, spaceId, namespaces: { private: privateNamespace, assisted: assistedNamespace } }, null, 2)}\n`,
  );
  console.log("Evidence written to docs/evidence.");
}

await rm(home, { recursive: true, force: true });
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} checks failed.`);
await owner.close();
process.exit(failures === 0 ? 0 : 1);
