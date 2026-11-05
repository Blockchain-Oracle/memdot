import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_API_URL } from "@memdot/config";
import { MemDotError } from "./errors.js";
import { localEmbedder } from "./local-embedder.js";
import { MemDot } from "./memdot.js";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const FILE_NAME = "credentials.json";
/** The model runtime is large, so it comes down the first time something needs it. */
const RUNTIME_PACKAGE = "@huggingface/transformers";
const RUNTIME_VERSION = "4.3.2";

/** What `memdot login` leaves on this machine, readable only by you. */
export interface Credentials {
  version: 1;
  api_url: string;
  /** How this API can be reached: a connected agent's key, or one pasted with --api-key. */
  api_key?: string;
  /** A connected agent's own key pair. The identity never leaves this file. */
  agent?: { id: string; label: string; identity: string; public_key: string };
  /** Where memories go when a command doesn't name a namespace. */
  namespace_id?: string;
  defaults?: { user_id?: string; agent_id?: string; run_id?: string };
  /** `memdot login` started without waiting: `--continue` collects it. */
  pending?: {
    id: string;
    code: string;
    url: string;
    poll_secret: string;
    expires_at: string;
    identity: string;
    public_key: string;
    label: string;
  };
  created_at?: string;
}

/** The credentials in force, after flags and environment. Never written back to the file. */
export interface ResolvedCredentials {
  apiUrl: string;
  apiKey: string | null;
  identity: string | null;
  namespaceId: string | null;
  userId: string | null;
  agentId: string | null;
  runId: string | null;
  recoveryCode: string | null;
  /** Where each of the above came from, for `memdot status`. */
  apiKeySource: "flag" | "env" | "file" | null;
}

export interface CredentialFlags {
  apiKey?: string | undefined;
  apiUrl?: string | undefined;
  namespace?: string | undefined;
  userId?: string | undefined;
  agentId?: string | undefined;
  runId?: string | undefined;
}

const env = (name: string): string | null => process.env[name]?.trim() || null;

/** `MEMDOT_CREDENTIALS_DIR` must be absolute: a relative one could land a key inside a repository. */
export function credentialsDir(): string {
  const configured = env("MEMDOT_CREDENTIALS_DIR");
  if (!configured) return join(homedir(), ".memdot");
  if (!isAbsolute(configured)) {
    throw new Error("MEMDOT_CREDENTIALS_DIR must be an absolute path.");
  }
  return configured;
}

export const credentialsPath = (): string => join(credentialsDir(), FILE_NAME);

export async function loadCredentials(): Promise<Credentials | null> {
  try {
    return JSON.parse(await readFile(credentialsPath(), "utf8")) as Credentials;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Couldn't read ${credentialsPath()}: ${(error as Error).message}`);
  }
}

/** Replaces the file in one step, so a crash never leaves half a key. */
export async function saveCredentials(credentials: Credentials): Promise<void> {
  const dir = credentialsDir();
  await mkdir(dir, { recursive: true, mode: DIR_MODE });
  await chmod(dir, DIR_MODE);
  const temporary = join(dir, `.${FILE_NAME}.${process.pid}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(credentials, null, 2)}\n`, { mode: FILE_MODE });
    await chmod(temporary, FILE_MODE);
    await rename(temporary, credentialsPath());
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export async function removeCredentials(): Promise<void> {
  await rm(credentialsPath(), { force: true });
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** What's saved, going to this API. A key and an agent belong to the address they came from. */
export function credentialsForApi(file: Credentials | null, apiUrl: string): Partial<Credentials> {
  if (!file) return {};
  if (sameOrigin(apiUrl, file.api_url)) return file;
  const { api_key: _key, agent: _agent, namespace_id: _namespace, ...rest } = file;
  return rest;
}

/** Flags beat the environment, which beats the file. */
export function resolveCredentials(
  file: Credentials | null,
  flags: CredentialFlags = {},
): ResolvedCredentials {
  const fromEnv = env("MEMDOT_API_KEY");
  const apiUrl = flags.apiUrl ?? env("MEMDOT_API_URL") ?? file?.api_url ?? DEFAULT_API_URL;
  // The saved key goes only where it was saved for: pointing at another address mustn't hand it over.
  const savedKey = file?.api_key && sameOrigin(apiUrl, file.api_url) ? file.api_key : null;
  const apiKey = flags.apiKey ?? fromEnv ?? savedKey;
  return {
    apiUrl,
    apiKey,
    // A key from somewhere else isn't this file's agent, so it doesn't get that agent's identity.
    identity:
      env("MEMDOT_AGENT_IDENTITY") ??
      (apiKey && apiKey === savedKey ? (file?.agent?.identity ?? null) : null),
    namespaceId: flags.namespace ?? env("MEMDOT_NAMESPACE") ?? file?.namespace_id ?? null,
    userId: flags.userId ?? env("MEMDOT_USER_ID") ?? file?.defaults?.user_id ?? null,
    agentId: flags.agentId ?? env("MEMDOT_AGENT_ID") ?? file?.defaults?.agent_id ?? null,
    runId: flags.runId ?? env("MEMDOT_RUN_ID") ?? file?.defaults?.run_id ?? null,
    recoveryCode: env("MEMDOT_RECOVERY_CODE"),
    apiKeySource: flags.apiKey ? "flag" : fromEnv ? "env" : savedKey ? "file" : null,
  };
}

/**
 * The local embedding runtime: already installed next to this code, or installed once under the
 * credentials folder. Progress goes to stderr, since stdout may be an MCP connection.
 */
async function embeddingRuntime() {
  const adopt = async (loaded: Record<string, unknown>) => {
    const runtime = (loaded.pipeline ? loaded : loaded.default) as {
      pipeline: never;
      env: { cacheDir: string };
    };
    runtime.env.cacheDir = join(credentialsDir(), "models");
    return runtime;
  };
  // Named indirectly so the package isn't bundled in, or looked for at build time.
  const name: string = RUNTIME_PACKAGE;
  try {
    return await adopt(await import(name));
  } catch {
    // Not installed with this code: use our own copy.
  }
  const dir = join(credentialsDir(), "runtime");
  const resolver = createRequire(join(dir, "package.json"));
  const installed = () => {
    try {
      return resolver.resolve(RUNTIME_PACKAGE);
    } catch {
      return null;
    }
  };
  if (!installed()) {
    process.stderr.write("Downloading the local embedding runtime, once. This takes a minute…\n");
    await mkdir(dir, { recursive: true, mode: DIR_MODE });
    await new Promise<void>((resolve, reject) => {
      execFile(
        "npm",
        [
          "install",
          "--prefix",
          process.platform === "win32" ? `"${dir}"` : dir,
          "--no-audit",
          "--no-fund",
          "--omit=dev",
          // Its binaries ship in the packages, so nothing here needs to run at install time.
          "--ignore-scripts",
          `${RUNTIME_PACKAGE}@${RUNTIME_VERSION}`,
        ],
        { shell: process.platform === "win32" },
        (error) => (error ? reject(error) : resolve()),
      );
    });
  }
  return adopt(await import(pathToFileURL(installed() as string).href));
}

/** Reaches MemDot the way the CLI does: flags, then the environment, then what `memdot login` saved. */
export async function connectFromMachine(
  client: string,
  flags: CredentialFlags & { identity?: string | undefined } = {},
): Promise<{ memdot: MemDot; resolved: ResolvedCredentials }> {
  const found = resolveCredentials(await loadCredentials(), flags);
  const resolved = flags.identity ? { ...found, identity: flags.identity } : found;
  if (!resolved.apiKey && !resolved.recoveryCode) {
    throw new MemDotError(
      401,
      "NOT_CONNECTED",
      "No MemDot credentials found. Set MEMDOT_API_KEY, or connect this machine with: memdot login",
    );
  }
  return { memdot: await clientFor(resolved, client), resolved };
}

/**
 * `connectFromMachine`, the first time something needs it. A failed attempt isn't kept, so a network
 * blip at startup doesn't turn memory off until the next restart.
 */
export function lazyConnection(
  client: string,
  flags: CredentialFlags & { identity?: string | undefined } = {},
): () => ReturnType<typeof connectFromMachine> {
  let held: ReturnType<typeof connectFromMachine> | null = null;
  return () => {
    held ??= connectFromMachine(client, flags).catch((error) => {
      held = null;
      throw error;
    });
    return held;
  };
}

/**
 * A client from resolved credentials. With an agent identity it opens what was shared with that
 * agent; with `MEMDOT_RECOVERY_CODE` it acts as the owner, for scripts that need to. The code is
 * only ever read from the environment, never stored.
 */
export async function clientFor(resolved: ResolvedCredentials, client: string): Promise<MemDot> {
  const memdot = MemDot.create({
    baseUrl: resolved.apiUrl,
    client,
    embedder: localEmbedder(embeddingRuntime),
    completeGrantsOnUnlock: false,
    ...(resolved.apiKey ? { apiKey: resolved.apiKey } : {}),
    ...(resolved.namespaceId ? { namespaceId: resolved.namespaceId } : {}),
  });
  if (resolved.recoveryCode) {
    await memdot.account.unlockWithRecoveryCode(resolved.recoveryCode);
  } else if (resolved.apiKey && resolved.identity) {
    memdot.connectAgent({ apiKey: resolved.apiKey, identity: resolved.identity });
  }
  return memdot;
}
