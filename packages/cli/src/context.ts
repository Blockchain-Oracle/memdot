import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import type { MemDot } from "@memdot/sdk";
import {
  type CredentialFlags,
  clientFor,
  loadCredentials,
  type ResolvedCredentials,
  resolveCredentials,
} from "@memdot/sdk/credentials";
import type { Command } from "commander";
import { CliError, EXIT, interactive } from "./output.js";

export const VERSION = "0.1.0";
const CLIENT = `cli/${VERSION}`;

export interface GlobalOptions extends CredentialFlags {
  apiKey?: string;
  apiUrl?: string;
  namespace?: string;
  userId?: string;
  agentId?: string;
  runId?: string;
}

const globals = (command: Command) => command.optsWithGlobals() as GlobalOptions;

export async function credentialsOf(command: Command): Promise<ResolvedCredentials> {
  return resolveCredentials(await loadCredentials(), globals(command));
}

/** A connected client, or a clear next step when this machine isn't connected yet. */
export async function connect(
  command: Command,
): Promise<{ memdot: MemDot; resolved: ResolvedCredentials }> {
  const resolved = await credentialsOf(command);
  if (!resolved.apiKey && !resolved.recoveryCode) {
    throw new CliError(
      "This machine isn't connected to MemDot.",
      EXIT.auth,
      "NOT_CONNECTED",
      "Run: memdot login",
    );
  }
  return { memdot: await clientFor(resolved, CLIENT), resolved };
}

/**
 * If any scope is named on this run, only those count; otherwise the saved defaults do. Mixing the
 * two would quietly narrow a search to a default the caller didn't ask for.
 */
export function scopeOf(
  command: Command,
  resolved: ResolvedCredentials,
): { userId?: string; agentId?: string; runId?: string } {
  const { userId, agentId, runId } = globals(command);
  const named = userId || agentId || runId;
  const scope = named
    ? { userId, agentId, runId }
    : { userId: resolved.userId, agentId: resolved.agentId, runId: resolved.runId };
  return {
    ...(scope.userId ? { userId: scope.userId } : {}),
    ...(scope.agentId ? { agentId: scope.agentId } : {}),
    ...(scope.runId ? { runId: scope.runId } : {}),
  };
}

/** The same scope as a filter, for reads: search and list take filters rather than scope fields. */
export function scopeFilter(scope: {
  userId?: string;
  agentId?: string;
  runId?: string;
}): Record<string, unknown>[] {
  return [
    ...(scope.userId ? [{ user_id: scope.userId }] : []),
    ...(scope.agentId ? [{ agent_id: scope.agentId }] : []),
    ...(scope.runId ? [{ run_id: scope.runId }] : []),
  ];
}

export function parseJson<T>(raw: string, what: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new CliError(`${what} isn't valid JSON.`, EXIT.usage, "BAD_JSON");
  }
}

export const parseInteger = (raw: string): number => {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new CliError(`"${raw}" isn't a whole number.`, EXIT.usage, "BAD_NUMBER");
  }
  return value;
};

export const parseFraction = (raw: string): number => {
  const value = Number(raw);
  if (Number.isNaN(value) || value < 0 || value > 1) {
    throw new CliError(`"${raw}" isn't between 0 and 1.`, EXIT.usage, "BAD_NUMBER");
  }
  return value;
};

/** Text from stdin, when something is piped in. Never waits on a terminal or in agent mode. */
export async function readStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return chunks.length ? Buffer.concat(chunks).toString("utf8").trim() || null : null;
}

/**
 * Stops anything that can't be undone unless the person said so. A script or agent has to pass
 * --force; a person gets asked, and anything but yes leaves it alone.
 */
export async function confirmDestructive(
  message: string,
  force: boolean | undefined,
): Promise<void> {
  if (force) return;
  if (!interactive()) {
    throw new CliError(
      `${message} Pass --force to go ahead.`,
      EXIT.conflict,
      "CONFIRMATION_REQUIRED",
    );
  }
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await prompt.question(`${message} This can't be undone. [y/N] `);
  prompt.close();
  if (answer.trim().toLowerCase() !== "y") {
    throw new CliError("Cancelled.", EXIT.ok, "CANCELLED");
  }
}

/** The space to use: named, or the only one this key can reach. */
export async function spaceOf(memdot: MemDot, named: string | undefined): Promise<string> {
  if (named) return named;
  const spaces = await memdot.spaces.list();
  const [only] = spaces;
  if (spaces.length === 1 && only) return only.id;
  throw new CliError(
    spaces.length === 0
      ? "There's no space here yet. Create one in the dashboard."
      : `Pick a space with --space: ${spaces.map((space) => `${space.id} (${space.name ?? "unnamed"})`).join(", ")}`,
    EXIT.usage,
    "SPACE_REQUIRED",
  );
}

export const readText = (path: string): Promise<string> =>
  readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    throw new CliError(
      `Couldn't read ${path}: ${error.code ?? error.message}`,
      EXIT.usage,
      "BAD_FILE",
    );
  });
