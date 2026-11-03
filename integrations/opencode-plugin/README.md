# MemDot for OpenCode

Long-term memory for coding agents: encrypted on your device, stored on Portaldot V3, and yours to move or revoke.

Generated from `integrations/agent-plugin-core`. Edit it there.

## Install

From a clone of the repository, add it to `opencode.json`, global or per project:

```json
{ "plugin": ["file:///absolute/path/to/integrations/opencode-plugin/core/opencode.mjs"] }
```

Needs Node 22.12 or later. The first session unpacks the MemDot CLI into `~/.memdot`.

## Connect

Run the MemDot login skill, or `memdot login`. You approve it in your browser and choose which spaces this agent can reach. Private namespaces stay encrypted: this machine decrypts them with the agent's own key.

## What it does here

- The first prompt of a session searches this repository's memories and adds what it finds. Tool calls are noted locally, with secrets removed. Every 10 turns, at compaction and at the end of a session, the conversation is saved in the background.
- Tools: `memdot_search`, `memdot_remember`, `memdot_list`, `memdot_get`, `memdot_forget`, `memdot_status`.
- The full MemDot MCP server, and the skills as `/memdot-search` and so on.
