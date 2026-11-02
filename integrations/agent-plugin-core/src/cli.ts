import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { basename, delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import {
  CLI_TARBALL_URL,
  CLI_TIMEOUT_MS,
  DOWNLOAD_TIMEOUT_MS,
  MIN_CLI_VERSION,
  PLUGIN_VERSION,
} from "./constants.js";
import { ensureDir, paths } from "./paths.js";
import { cliEnvironment } from "./settings.js";
import { withLock } from "./store.js";

const run = promisify(execFile);
const INSTALL_LOCK = "install.lock";
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/**
 * A real node. Some hosts run plugin code in their own runtime, where `process.execPath` is the
 * host itself; the CLI needs node.
 */
export function nodeBinary(): string {
  const runtime = process.versions as Record<string, string | undefined>;
  return !runtime.bun && /^node(\.exe)?$/i.test(basename(process.execPath))
    ? process.execPath
    : "node";
}

const versionParts = (version: string) =>
  version.split(".").map((part) => Number.parseInt(part, 10));

export function versionAtLeast(version: string, wanted: string): boolean {
  const have = versionParts(version);
  for (const [index, part] of versionParts(wanted).entries()) {
    const mine = have[index] ?? 0;
    if (mine !== part) return mine > part;
  }
  return true;
}

function packageVersion(packageDir: string): string | null {
  try {
    const { version } = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
      version?: string;
    };
    return version ?? null;
  } catch {
    return null;
  }
}

const usable = (packageDir: string) => {
  const version = packageVersion(packageDir);
  return version !== null && versionAtLeast(version, MIN_CLI_VERSION);
};

/** The Node CLI on this machine: our own copy, or one you installed. `memdot` could be Python's. */
export function findCli(): string | null {
  const override = process.env.MEMDOT_CLI?.trim();
  if (override) return override;
  const own = join(paths().cli, "dist", "index.mjs");
  if (existsSync(own) && usable(paths().cli)) return own;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(dir, "memdot");
    if (!dir || !existsSync(candidate)) continue;
    try {
      const real = realpathSync(candidate);
      if (real.endsWith(".mjs") && usable(dirname(dirname(real)))) return real;
    } catch {
      // A dead link: keep looking.
    }
  }
  return null;
}

async function downloadCli(): Promise<void> {
  const { cli, cliTemp } = paths();
  await ensureDir(cliTemp);
  const staging = await mkdtemp(join(cliTemp, "staging-"));
  try {
    const url = process.env.MEMDOT_CLI_URL?.trim() || CLI_TARBALL_URL;
    const response = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`Couldn't download the CLI: ${response.status} from ${url}`);
    const archive = join(cliTemp, `${basename(staging)}.tgz`);
    await writeFile(archive, new Uint8Array(await response.arrayBuffer()), { mode: 0o600 });
    try {
      await run("tar", ["-xzf", archive, "-C", staging, "--strip-components=1"]);
    } finally {
      await rm(archive, { force: true });
    }
    if (!existsSync(join(staging, "dist", "index.mjs")) || !usable(staging)) {
      throw new Error(`The CLI at ${url} is older than this plugin needs (${MIN_CLI_VERSION}).`);
    }
    const old = `${cli}.old-${process.pid}`;
    if (existsSync(cli)) await rename(cli, old);
    await rename(staging, cli);
    await rm(old, { recursive: true, force: true });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/** The CLI, unpacked into ~/.memdot the first time. It has no dependencies, so npm isn't needed. */
export async function ensureCli(): Promise<string> {
  const found = findCli();
  if (found) return found;
  await withLock(
    join(paths().cliTemp, INSTALL_LOCK),
    async () => {
      if (!findCli()) await downloadCli();
    },
    { waitMs: DOWNLOAD_TIMEOUT_MS },
  );
  const installed = findCli();
  if (!installed) throw new Error("The MemDot CLI isn't available yet.");
  return installed;
}

export interface CliResult {
  exit: number;
  ok: boolean;
  data: unknown;
  error: { code: string; message: string; hint?: string } | null;
  timedOut: boolean;
}

/** Runs one CLI command and reads its JSON answer. Text goes over stdin, so it's never on a command line. */
export async function runCli(
  host: string,
  args: string[],
  { input, timeoutMs = CLI_TIMEOUT_MS }: { input?: string; timeoutMs?: number } = {},
): Promise<CliResult> {
  const cli = findCli();
  if (!cli) {
    return {
      exit: 1,
      ok: false,
      data: null,
      error: { code: "CLI_MISSING", message: "The MemDot CLI isn't installed yet." },
      timedOut: false,
    };
  }
  return new Promise((resolve) => {
    const child = execFile(
      nodeBinary(),
      [cli, "--agent", ...args],
      {
        env: cliEnvironment(host, PLUGIN_VERSION),
        timeout: timeoutMs,
        maxBuffer: MAX_OUTPUT_BYTES,
      },
      (failure, stdout) => {
        const timedOut = Boolean(failure && (failure as { killed?: boolean }).killed);
        const exit = failure ? Number((failure as { code?: unknown }).code) || 1 : 0;
        let envelope: { status?: string; data?: unknown; error?: CliResult["error"] } = {};
        try {
          envelope = JSON.parse(stdout) as typeof envelope;
        } catch {
          // Killed or crashed before it could answer.
        }
        resolve({
          exit,
          ok: exit === 0 && envelope.status === "success",
          data: envelope.data ?? null,
          error:
            envelope.error ??
            (exit === 0
              ? null
              : {
                  code: timedOut ? "TIMEOUT" : "FAILED",
                  message: timedOut ? "The CLI took too long." : (failure?.message ?? "It failed."),
                }),
          timedOut,
        });
      },
    );
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(input ?? "");
  });
}
