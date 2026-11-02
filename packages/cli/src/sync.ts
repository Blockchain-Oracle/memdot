import { chmod, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

const VARIABLE = "MEMDOT_API_KEY";
/** `[ \t]`, not `\s`: a trailing newline must stay where it is. */
const EXPORT_LINE = new RegExp(`^([ \\t]*export[ \\t]+${VARIABLE}[ \\t]*=[ \\t]*).*$`, "m");
const SHELL_FILES = [".zshrc", ".bashrc", ".bash_profile"];

/** Replaces a file in one step, keeping its permissions. */
async function replace(path: string, content: string): Promise<void> {
  const { mode } = await stat(path);
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try {
    await writeFile(temporary, content);
    await chmod(temporary, mode);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function syncSettings(path: string, key: string): Promise<boolean> {
  const raw = await readFile(path, "utf8");
  const settings = JSON.parse(raw) as { env?: Record<string, string> };
  if (!settings.env || !(VARIABLE in settings.env) || settings.env[VARIABLE] === key) return false;
  settings.env[VARIABLE] = key;
  await replace(path, `${JSON.stringify(settings, null, 2)}\n`);
  return true;
}

async function syncShell(path: string, key: string): Promise<boolean> {
  const raw = await readFile(path, "utf8");
  const match = raw.match(EXPORT_LINE);
  if (!match) return false;
  const next = raw.replace(EXPORT_LINE, `$1"${key}"`);
  if (next === raw) return false;
  await replace(path, next);
  return true;
}

/**
 * After a new key, updates the old one wherever you already keep it, so an agent doesn't go on
 * using a revoked key. Only ever changes a line that's there: it never adds a key to a file that
 * didn't have one. A file it can't read or parse is left alone.
 */
export async function syncKey(key: string): Promise<string[]> {
  const home = homedir();
  const changed: string[] = [];
  const attempt = async (path: string, sync: (p: string, k: string) => Promise<boolean>) => {
    try {
      if (await sync(path, key)) changed.push(path);
    } catch {
      // Missing or unreadable: nothing of ours in it.
    }
  };
  await attempt(join(home, ".claude", "settings.json"), syncSettings);
  for (const file of SHELL_FILES) await attempt(join(home, file), syncShell);
  return changed;
}
