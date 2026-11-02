import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const GIT_TIMEOUT_MS = 1_500;
const HASH_CHARS = 10;
const SLUG_CHARS = 40;

export interface RepoIdentity {
  /** The folder sessions here belong to. */
  root: string;
  /** What memories from this repository are filed under: readable in the dashboard, unique by hash. */
  id: string;
  name: string;
  branch: string | null;
  sha: string | null;
}

async function git(cwd: string, ...args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run("git", ["-C", cwd, ...args], { timeout: GIT_TIMEOUT_MS });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** One spelling for a remote however it was cloned, with any credentials in the address gone. */
export function normalizeRemote(raw: string): string {
  let value = raw.trim();
  const scp = value.match(/^(?:[^@/]+@)?([^:/]+):(?!\/\/)(.+)$/);
  if (scp) value = `https://${scp[1]}/${scp[2]}`;
  value = value.replace(/\.git\/?$/, "").replace(/\/+$/, "");
  try {
    const url = new URL(value);
    const host = url.port ? `${url.hostname}:${url.port}` : url.hostname;
    return `https://${host.toLowerCase()}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    return value;
  }
}

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_CHARS) || "repo";

const shortHash = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, HASH_CHARS);

export async function identifyRepo(cwd: string): Promise<RepoIdentity> {
  const found = await git(cwd, "rev-parse", "--show-toplevel");
  const root = found ?? (await realpath(cwd).catch(() => cwd));
  const remote = found ? await git(root, "config", "--get", "remote.origin.url") : null;
  const identity = remote ? normalizeRemote(remote) : `local:${root}`;
  const parts = remote ? identity.split("/").filter(Boolean).slice(-2) : [basename(root)];
  const name = parts.join("/");
  const branch = found ? await git(root, "rev-parse", "--abbrev-ref", "HEAD") : null;
  const sha = found ? await git(root, "rev-parse", "--short", "HEAD") : null;
  return {
    root,
    id: `repo-${slug(parts.join("-"))}-${shortHash(identity)}`,
    name,
    branch: branch === "HEAD" ? null : branch,
    sha,
  };
}

/** Where a path really is. A file that's gone by now still has a folder that isn't. */
function resolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(resolved(parent), basename(path));
  }
}

/** A path as the repository knows it, or nothing for one outside it. Links count as where they lead. */
export function repoPath(root: string, path: string): string | null {
  const within = relative(root, resolved(isAbsolute(path) ? path : join(root, path)));
  if (!within || within.startsWith("..") || within.startsWith(sep)) return null;
  return within.split(sep).join("/");
}
