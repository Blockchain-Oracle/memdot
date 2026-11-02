# MemDot for Cursor

Long-term memory for coding agents: encrypted on your device, stored on Portaldot V3, and yours to move or revoke.

Generated from `integrations/agent-plugin-core`. Edit it there.

## Install

Cursor installs plugins from its Customize page: import `https://github.com/Blockchain-Oracle/memdot` as a team marketplace, or copy this folder to `~/.cursor/plugins/local/memdot` and reload the window. To try it for one run:

```bash
agent --plugin-dir integrations/cursor-plugin
```

Needs Node 22.12 or later. The first session unpacks the MemDot CLI into `~/.memdot`.

## Connect

Run the MemDot login skill, or `memdot login`. You approve it in your browser and choose which spaces this agent can reach. Private namespaces stay encrypted: this machine decrypts them with the agent's own key.

## What it does here

- Cursor can't add context to a prompt, so what the first prompt finds arrives with the first tool result. Answers that use no tools don't get it, but the MCP tools are always there.
- Every tool call is noted locally, with secrets removed and no file contents.
- Every 10 turns, at compaction and at the end of a session, the conversation is saved in the background.
- `/memdot-search`, `/memdot-remember`, `/memdot-forget`, `/memdot-status`, `/memdot-pause`, `/memdot-resume`, `/memdot-login`.
- The `sidekick` agent, and the full MemDot MCP server.
