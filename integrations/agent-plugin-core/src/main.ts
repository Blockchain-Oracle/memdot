import { spawn } from "node:child_process";
import { readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { ensureCli, findCli, nodeBinary, runCli } from "./cli.js";
import { MAX_MESSAGE_CHARS, PLUGIN_VERSION } from "./constants.js";
import { HOST_ADAPTERS } from "./hosts/index.js";
import {
  deliverPending,
  installLauncher,
  maintain,
  prepareFlush,
  searchMemories,
  startWorker,
} from "./lifecycle.js";
import { ensureDir, FILE_MODE, logError, paths } from "./paths.js";
import { formatMemories } from "./prompts.js";
import { bounded } from "./redact.js";
import { identifyRepo } from "./repo.js";
import {
  cliEnvironment,
  connected,
  SEARCH_SCOPES,
  type SearchScope,
  settings,
} from "./settings.js";
import { isPaused } from "./store.js";

/** Anything this slow in a hook is stuck, and a stuck hook must not hold the host up. */
const HOOK_DEADLINE_MS = 30_000;
const PLUGIN_HOST_FOR_CONTROL = "skill";
const script = () => realpathSync(process.argv[1] as string);

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

async function runHook(host: string, event: string): Promise<void> {
  const adapter = HOST_ADAPTERS[host];
  if (!adapter) return;
  const deadline = setTimeout(() => process.exit(0), HOOK_DEADLINE_MS);
  deadline.unref();
  let printed = "";
  try {
    const raw = await readStdin();
    let input: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") input = parsed;
    } catch {
      // Nothing usable came in: it's handled as an event with no details.
    }
    const output = await adapter.handle(
      { host, script: script(), deliversOnTool: adapter.deliversOnTool ?? false },
      event,
      input,
    );
    printed = adapter.render(event, output);
  } catch (error) {
    await logError(`${host} ${event}`, error);
    printed = adapter.render(event, {});
  }
  if (printed) process.stdout.write(`${printed}\n`);
}

/** The MCP server is the CLI's: this only makes sure it's there, then hands over the streams. */
async function runMcp(host: string): Promise<void> {
  await installLauncher(script()).catch((error) => logError("launcher", error));
  const cli = await ensureCli();
  const child = spawn(nodeBinary(), [cli, "mcp"], {
    stdio: "inherit",
    env: cliEnvironment(host, PLUGIN_VERSION),
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("exit", (code) => process.exit(code ?? 0));
}

// ── What the skills run ────────────────────────────────────────────────────────────────────────

interface Flags {
  values: string[];
  flags: Record<string, string | true>;
}

function parseFlags(args: string[]): Flags {
  const out: Flags = { values: [], flags: {} };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] as string;
    if (!arg.startsWith("--")) {
      out.values.push(arg);
      continue;
    }
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out.flags[arg.slice(2)] = next;
      i += 1;
    } else {
      out.flags[arg.slice(2)] = true;
    }
  }
  return out;
}

const textFrom = async (values: string[]) => values.join(" ").trim() || (await readStdin()).trim();
const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

async function currentRepo() {
  return identifyRepo(process.cwd());
}

async function commandSearch(args: string[]): Promise<void> {
  const { values, flags } = parseFlags(args);
  const query = await textFrom(values);
  if (!query) fail("Say what to search for.");
  const options = settings();
  const named = flags.scope as SearchScope | undefined;
  if (named && !SEARCH_SCOPES.includes(named))
    fail(`--scope is one of ${SEARCH_SCOPES.join(", ")}.`);
  const { memories, error } = await searchMemories(PLUGIN_HOST_FOR_CONTROL, query, {
    scope: named ?? options.searchScope,
    repo: await currentRepo(),
    topK: Number(flags["top-k"]) || options.topK,
  });
  if (error) fail(error);
  const text = formatMemories(memories, { heading: "", limit: options.maxContextChars });
  console.log(text || "Nothing found.");
  if (memories.length) console.log(`\nIds: ${memories.map((memory) => memory.id).join(" ")}`);
}

async function commandRemember(args: string[]): Promise<void> {
  const { values } = parseFlags(args);
  const fact = bounded(await textFrom(values), MAX_MESSAGE_CHARS);
  if (!fact) fail("Say what to remember.");
  const repo = await currentRepo();
  const result = await runCli(
    PLUGIN_HOST_FOR_CONTROL,
    [
      "add",
      "--no-infer",
      "-u",
      settings().userId,
      "--agent-id",
      repo.id,
      "-m",
      JSON.stringify({ source: "plugin_remember", repo: repo.name }),
    ],
    { input: fact },
  );
  if (!result.ok) fail(result.error?.message ?? "Couldn't save it.");
  const added = (result.data as { results?: { id: string; memory: string }[] }).results ?? [];
  console.log(
    added.length
      ? `Remembered: ${added.map((memory) => `${memory.memory} (${memory.id})`).join("; ")}`
      : "That's already remembered.",
  );
}

async function commandForget(args: string[]): Promise<void> {
  const { values, flags } = parseFlags(args);
  if (flags.repo) {
    const repo = await currentRepo();
    if (flags.yes !== true) {
      const preview = await runCli(PLUGIN_HOST_FOR_CONTROL, [
        "delete",
        "--all",
        "--dry-run",
        "--agent-id",
        repo.id,
      ]);
      if (!preview.ok) fail(preview.error?.message ?? "Couldn't count them.");
      const { would_delete: count } = preview.data as { would_delete: number };
      console.log(
        `This would forget ${count} memories saved for ${repo.name}. Nothing changed. To go ahead, run this again with --yes.`,
      );
      return;
    }
    const result = await runCli(PLUGIN_HOST_FOR_CONTROL, [
      "delete",
      "--all",
      "--force",
      "--agent-id",
      repo.id,
    ]);
    if (!result.ok) fail(result.error?.message ?? "Couldn't forget them.");
    console.log(`Forgotten everything saved for ${repo.name}.`);
    return;
  }
  if (values.length === 0) fail("Give the ids to forget, or --repo for this whole repository.");
  if (flags.yes !== true)
    fail("Forgetting can't be undone. Confirm with the user, then pass --yes.");
  for (const id of values) {
    const result = await runCli(PLUGIN_HOST_FOR_CONTROL, ["delete", id, "--force"]);
    console.log(result.ok ? `Forgotten: ${id}` : `Couldn't forget ${id}: ${result.error?.message}`);
  }
}

async function commandPause(): Promise<void> {
  const { paused, plugin } = paths();
  await ensureDir(plugin);
  writeFileSync(paused, "", { mode: FILE_MODE });
  console.log(
    "MemDot stopped saving and recalling on its own. Tools you call directly still work.",
  );
}

function commandResume(): void {
  rmSync(paths().paused, { force: true });
  console.log("MemDot is saving and recalling again. Nothing from the pause was saved.");
}

async function commandStatus(args: string[]): Promise<void> {
  const { flags } = parseFlags(args);
  const { pending: pendingDir, failed: failedDir, errors } = paths();
  const list = (dir: string) => {
    try {
      return readdirSync(dir).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }
  };
  const waiting = await Promise.all(
    list(pendingDir).map(async (name) =>
      JSON.parse(await readFile(join(pendingDir, name), "utf8").catch(() => "{}")),
    ),
  );
  const repo = await currentRepo();
  const options = settings();
  const cli = findCli();
  const who = connected() && cli ? await runCli(PLUGIN_HOST_FOR_CONTROL, ["whoami"]) : null;
  const connection = await readFile(paths().connection, "utf8")
    .then((raw) => JSON.parse(raw))
    .catch(() => null);
  const lastError = await readFile(errors, "utf8")
    .then((raw) => raw.trim().split("\n").at(-1) ?? null)
    .catch(() => null);
  const status = {
    version: PLUGIN_VERSION,
    connected: connected(),
    key_works: who ? who.ok : null,
    key_problem: who && !who.ok ? (who.error?.hint ?? who.error?.message ?? null) : null,
    agent: who?.ok ? ((who.data as { agent?: { label?: string } }).agent?.label ?? null) : null,
    namespace: connection?.namespaceId ?? null,
    mode: connection?.mode ?? null,
    paused: await isPaused(),
    auto_save: options.autoSave,
    repo: repo.name,
    repo_scope: repo.id,
    user: options.userId,
    waiting_to_save: waiting.length,
    waiting_reason: waiting.find((packet) => packet.lastError)?.lastError ?? null,
    could_not_save: list(failedDir).length,
    cli: cli ?? "not installed yet",
    last_error: lastError,
  };
  if (flags.json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  for (const [key, value] of Object.entries(status)) console.log(`${key}: ${value ?? "none"}`);
}

/** Login is the CLI's. Agents can't answer a prompt, so it returns an address and a code to pass on. */
async function commandLogin(args: string[]): Promise<void> {
  await ensureCli();
  const { flags } = parseFlags(args);
  const host = typeof flags.client === "string" ? flags.client : "coding agent";
  const result = flags.continue
    ? await runCli(PLUGIN_HOST_FOR_CONTROL, ["login", "--continue", "--wait", "100"], {
        timeoutMs: 110_000,
      })
    : await runCli(PLUGIN_HOST_FOR_CONTROL, [
        "login",
        "--no-wait",
        "--label",
        `MemDot plugin for ${host}`,
      ]);
  if (!result.ok) fail(result.error?.message ?? "Couldn't start the login.");
  const data = result.data as { connected?: boolean; url?: string; code?: string };
  if (data.connected) {
    await rm(paths().connection, { force: true });
    await maintain(PLUGIN_HOST_FOR_CONTROL).catch((error) => logError("login", error));
    console.log(
      "Connected. Restart this session, or reload plugins, to bring the MemDot tools up.",
    );
    return;
  }
  if (data.url) console.log(`Open ${data.url}\nand type this code: ${data.code}`);
  else console.log("Still waiting for the approval. Run this again with --continue.");
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "hook":
      await runHook(rest[0] as string, rest[1] as string);
      return;
    case "mcp":
      await runMcp(rest[0] ?? "agent");
      return;
    case "worker": {
      const [host, job, ...more] = rest;
      if (job === "maintain") await maintain(host as string);
      if (job === "flush") {
        await prepareFlush(more[0] as string, more.includes("--force"));
        await deliverPending(host as string);
      }
      return;
    }
    case "search":
      await commandSearch(rest);
      return;
    case "remember":
      await commandRemember(rest);
      return;
    case "forget":
      await commandForget(rest);
      return;
    case "pause":
      await commandPause();
      return;
    case "resume":
      commandResume();
      startWorker({ host: PLUGIN_HOST_FOR_CONTROL, script: script() }, "maintain");
      return;
    case "status":
      await commandStatus(rest);
      return;
    case "login":
      await commandLogin(rest);
      return;
    case "version":
      console.log(PLUGIN_VERSION);
      return;
    default:
      console.error(
        "Usage: memdot-plugin search|remember|forget|status|pause|resume|login|version",
      );
      process.exitCode = 2;
  }
}

main().catch(async (error) => {
  await logError("main", error);
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
