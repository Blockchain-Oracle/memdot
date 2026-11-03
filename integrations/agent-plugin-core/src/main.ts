import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { ensureCli, nodeBinary, runCli } from "./cli.js";
import { PLUGIN_VERSION } from "./constants.js";
import {
  forgetIds,
  forgetRepo,
  pause,
  rememberText,
  resume,
  searchText,
  statusReport,
} from "./control.js";
import { HOST_ADAPTERS } from "./hosts/index.js";
import {
  deliverPending,
  installLauncher,
  maintain,
  prepareFlush,
  startWorker,
} from "./lifecycle.js";
import { logError, paths } from "./paths.js";
import { cliEnvironment } from "./settings.js";

/** Anything this slow in a hook is stuck, and a stuck hook must not hold the host up. */
const HOOK_DEADLINE_MS = 30_000;
/** What the activity log calls a skill running a command. */
const CONTROL_HOST = "skill";
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
  throw new Error(message);
};

async function commandSearch(args: string[]): Promise<void> {
  const { values, flags } = parseFlags(args);
  const query = await textFrom(values);
  if (!query) fail("Say what to search for.");
  console.log(
    await searchText(CONTROL_HOST, query, {
      scope: flags.scope as string | undefined,
      topK: Number(flags["top-k"]) || undefined,
      cwd: process.cwd(),
    }),
  );
}

async function commandForget(args: string[]): Promise<void> {
  const { values, flags } = parseFlags(args);
  const confirmed = flags.yes === true;
  if (flags.repo) {
    console.log(await forgetRepo(CONTROL_HOST, process.cwd(), confirmed));
    return;
  }
  if (values.length === 0) fail("Give the ids to forget, or --repo for this whole repository.");
  if (!confirmed) fail("Forgetting can't be undone. Confirm with the user, then pass --yes.");
  console.log(await forgetIds(CONTROL_HOST, values));
}

async function commandStatus(args: string[]): Promise<void> {
  const status = await statusReport(CONTROL_HOST, process.cwd());
  if (parseFlags(args).flags.json) {
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
    ? await runCli(CONTROL_HOST, ["login", "--continue", "--wait", "100"], {
        timeoutMs: 110_000,
      })
    : await runCli(CONTROL_HOST, ["login", "--no-wait", "--label", `MemDot plugin for ${host}`]);
  if (!result.ok) fail(result.error?.message ?? "Couldn't start the login.");
  const data = result.data as { connected?: boolean; url?: string; code?: string };
  if (data.connected) {
    await rm(paths().connection, { force: true });
    await maintain(CONTROL_HOST).catch((error) => logError("login", error));
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
      console.log(await rememberText(CONTROL_HOST, await textFrom(rest), process.cwd()));
      return;
    case "forget":
      await commandForget(rest);
      return;
    case "pause":
      console.log(await pause());
      return;
    case "resume":
      console.log(resume());
      startWorker({ host: CONTROL_HOST, script: script() }, "maintain");
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

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
