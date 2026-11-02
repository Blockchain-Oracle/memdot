import { clientFor, loadCredentials, resolveCredentials } from "@memdot/sdk/credentials";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { buildServer } from "./server.js";

/**
 * The local MCP server: it runs on your machine and decrypts here with the agent's own key, so it
 * reaches Private namespaces. stdout is the protocol; everything else goes to stderr.
 */
export async function serveLocal(version: string): Promise<void> {
  const resolved = resolveCredentials(await loadCredentials());
  if (!resolved.apiKey) {
    process.stderr.write("MemDot isn't connected yet. Run: memdot login\n");
    process.exit(1);
  }
  const memdot = await clientFor(resolved, `mcp-local/${version}`);
  serveStdio(() =>
    buildServer(memdot, {
      version,
      mode: "local",
      namespaceId: resolved.namespaceId,
      userId: resolved.userId,
      agentId: resolved.agentId,
      runId: resolved.runId,
      canShare: memdot.account.unlocked,
    }),
  );
}
