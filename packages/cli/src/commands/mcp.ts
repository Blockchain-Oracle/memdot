import { homedir } from "node:os";
import { join } from "node:path";
import { serveLocal } from "@memdot/mcp/stdio";
import type { Command } from "commander";
import { credentialsOf, VERSION } from "../context.js";
import { CliError, EXIT, emit } from "../output.js";

/** How each client is told about the local server, and where it keeps that. */
const CLIENTS: Record<string, { path: string; note?: string }> = {
  "claude-code": { path: "claude mcp add memdot -- memdot mcp" },
  "claude-desktop": {
    path: join(homedir(), "Library/Application Support/Claude/claude_desktop_config.json"),
  },
  cursor: { path: join(homedir(), ".cursor/mcp.json") },
};

export function mcpCommands(program: Command): void {
  const mcp = program
    .command("mcp")
    .description("Run the local MCP server over stdio, or print how to add it to a client")
    .action(async () => {
      await serveLocal(VERSION);
    });

  mcp
    .command("config")
    .description("What to add to a client's settings")
    .option("--client <name>", Object.keys(CLIENTS).join(", "), "claude-desktop")
    .option("--hosted", "the hosted server instead: Assisted namespaces, signs in with OAuth")
    .action(async (options, command: Command) => {
      const client = CLIENTS[options.client];
      if (!client) {
        throw new CliError(
          `Unknown client. Use ${Object.keys(CLIENTS).join(", ")}.`,
          EXIT.usage,
          "BAD_CLIENT",
        );
      }
      const { apiUrl } = await credentialsOf(command);
      const server = options.hosted
        ? { type: "http", url: `${apiUrl}/mcp` }
        : { command: "memdot", args: ["mcp"] };
      const config = { mcpServers: { memdot: server } };
      emit({
        data: { client: options.client, where: client.path, config },
        text: () => {
          console.log(`Add this to ${client.path}:\n`);
          console.log(JSON.stringify(config, null, 2));
        },
      });
    });
}
