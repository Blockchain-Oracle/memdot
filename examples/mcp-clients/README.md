# Connect an MCP client

Two servers, and the choice is about keys.

| | Local: `memdot mcp` | Hosted: `https://api.84.46.247.92.sslip.io/mcp` |
|---|---|---|
| Runs | On your machine | On MemDot |
| Signs in with | `memdot login` | OAuth, in your browser |
| Reaches | Everything you connected: Private and Assisted namespaces, and files | Assisted namespaces only, because it holds no key |
| Use it for | Coding agents and desktop apps on your own machine | Web-based clients, or anywhere you can't run a command |

## Set up the local server

```bash
npm install -g https://app.84.46.247.92.sslip.io/cli/memdot-cli.tgz
memdot login
```

The CLI writes the config for the clients it knows, with full paths, since a desktop app doesn't have your shell's `PATH`:

```bash
memdot mcp config --client claude-desktop --write
memdot mcp config --client cursor --write
memdot mcp config --client claude-code
```

The last one prints the command to run. For anything else, copy from [`configs`](configs) and restart the client.

| Client | File | Where it goes |
|---|---|---|
| Claude Desktop | [`claude-desktop.json`](configs/claude-desktop.json) | `~/Library/Application Support/Claude/claude_desktop_config.json` on macOS |
| Cursor | [`cursor.json`](configs/cursor.json) | `~/.cursor/mcp.json` |
| VS Code | [`vscode.json`](configs/vscode.json) | `.vscode/mcp.json` |
| Codex | [`codex.toml`](configs/codex.toml) | `~/.codex/config.toml` |
| Windsurf | [`windsurf.json`](configs/windsurf.json) | `~/.codeium/windsurf/mcp_config.json` |
| Any client, hosted | [`hosted.json`](configs/hosted.json) | That client's MCP settings |

## Check that it works

[`smoke.mjs`](smoke.mjs) speaks the protocol directly: it lists the tools, saves a memory, finds it and forgets it. It needs Node and a connection, and uses an Assisted namespace if you set `MEMDOT_NAMESPACE` to one:

```bash
node smoke.mjs
```

Then ask your client something like "remember that I deploy on Fridays", and in a new conversation, "when do I deploy?".

To give a coding agent memory that works without being asked, install the [agent plugin](../../integrations) instead. It brings this server along with it.
