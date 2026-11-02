import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { serveLocal } from "@memdot/mcp/stdio";
import type { Command } from "commander";
import { credentialsOf, VERSION } from "../context.js";
import { CliError, EXIT, emit } from "../output.js";

/** Where each client keeps its servers. */
const FILES: Record<string, () => string> = {
  "claude-desktop": () =>
    process.platform === "win32"
      ? join(process.env.APPDATA ?? homedir(), "Claude", "claude_desktop_config.json")
      : process.platform === "darwin"
        ? join(homedir(), "Library/Application Support/Claude/claude_desktop_config.json")
        : join(homedir(), ".config/Claude/claude_desktop_config.json"),
  cursor: () => join(homedir(), ".cursor/mcp.json"),
};
const CLIENTS = ["claude-code", ...Object.keys(FILES)];
const PRIVATE_FILE = 0o600;

/** Adds our server and leaves the rest alone. The old file stays next to it, in case. */
async function addToSettings(path: string, server: unknown): Promise<void> {
  let settings: { mcpServers?: Record<string, unknown> } = {};
  // Settings can hold other servers' tokens, so a new copy is never more readable than the old one.
  let mode = PRIVATE_FILE;
  try {
    const raw = await readFile(path, "utf8");
    settings = JSON.parse(raw) as typeof settings;
    mode = (await stat(path)).mode & 0o777;
    await copyFile(path, `${path}.bak`);
    await chmod(`${path}.bak`, mode);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new CliError(
        `${path} isn't valid JSON, so it was left alone.`,
        EXIT.conflict,
        "BAD_SETTINGS",
      );
    }
    await mkdir(dirname(path), { recursive: true });
  }
  settings.mcpServers = { ...settings.mcpServers, memdot: server };
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Safe to paste: an install path can have spaces, and the address came from settings. */
const shellQuote = (value: string) =>
  /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;

export function mcpCommands(program: Command): void {
  const mcp = program
    .command("mcp")
    .description("Run the local MCP server over stdio, or set a client up to use it")
    .action(async () => {
      await serveLocal(VERSION);
    });

  mcp
    .command("config")
    .description("What a client needs to use MemDot; --write adds it to the client's settings")
    .option("--client <name>", CLIENTS.join(", "), "claude-desktop")
    .option("--hosted", "the hosted server: Assisted namespaces, signs in with OAuth")
    .option("--write", "add it to that client's settings file")
    .action(async (options, command: Command) => {
      if (!CLIENTS.includes(options.client)) {
        throw new CliError(`Unknown client. Use ${CLIENTS.join(", ")}.`, EXIT.usage, "BAD_CLIENT");
      }
      const { apiUrl } = await credentialsOf(command);
      // Full paths: an app started from the dock doesn't have your shell's PATH.
      const script = await realpath(process.argv[1] as string);
      const server = options.hosted
        ? { type: "http", url: `${apiUrl}/mcp` }
        : { command: process.execPath, args: [script, "mcp"] };

      if (options.client === "claude-code") {
        const line = options.hosted
          ? `claude mcp add --transport http memdot ${shellQuote(`${apiUrl}/mcp`)}`
          : `claude mcp add memdot -- ${shellQuote(process.execPath)} ${shellQuote(script)} mcp`;
        emit({ data: { client: options.client, run: line }, text: () => console.log(line) });
        return;
      }

      const path = (FILES[options.client] as () => string)();
      if (options.write) await addToSettings(path, server);
      const config = { mcpServers: { memdot: server } };
      emit({
        data: { client: options.client, where: path, written: Boolean(options.write), config },
        text: () => {
          if (options.write) {
            console.log(`Added to ${path}. Restart the app to pick it up.`);
            return;
          }
          console.log(`Add this to ${path}, or run this again with --write:\n`);
          console.log(JSON.stringify(config, null, 2));
        },
      });
    });
}
