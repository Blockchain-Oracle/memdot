import { appendFile, chmod, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { MAX_ERROR_LOG_BYTES } from "./constants.js";

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/** Everything lives under ~/.memdot, the same on every host: some hosts give a plugin no folder. */
export function memdotHome(): string {
  const configured = process.env.MEMDOT_CREDENTIALS_DIR?.trim();
  return configured && isAbsolute(configured) ? configured : join(homedir(), ".memdot");
}

export const paths = () => {
  const home = memdotHome();
  const plugin = join(home, "plugin");
  return {
    home,
    credentials: join(home, "credentials.json"),
    launcher: join(home, "bin", "memdot-plugin.mjs"),
    cli: join(home, "cli", "current"),
    cliTemp: join(home, "cli"),
    plugin,
    sessions: join(plugin, "sessions"),
    pending: join(plugin, "pending"),
    failed: join(plugin, "failed"),
    paused: join(plugin, "paused"),
    errors: join(plugin, "errors.log"),
    connection: join(plugin, "connection.json"),
    maintained: join(plugin, "maintained"),
    deliverLock: join(plugin, "deliver.lock"),
  };
};

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: DIR_MODE });
}

/** Replaces a file in one step, readable only by you. */
export async function writePrivate(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.tmp`);
  try {
    await writeFile(temporary, content, { mode: FILE_MODE });
    await chmod(temporary, FILE_MODE);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Hooks must never get in the host's way, so what goes wrong is kept here for `status`. */
export async function logError(where: string, error: unknown): Promise<void> {
  const { errors } = paths();
  const message = error instanceof Error ? error.message : String(error);
  try {
    await ensureDir(dirname(errors));
    const size = await stat(errors).then(
      (found) => found.size,
      () => 0,
    );
    if (size > MAX_ERROR_LOG_BYTES) await rename(errors, `${errors}.old`);
    await appendFile(errors, `${new Date().toISOString()} ${where}: ${message}\n`, {
      mode: FILE_MODE,
    });
  } catch {
    // Nowhere left to report it.
  }
}
