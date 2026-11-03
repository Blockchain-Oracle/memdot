# MemDot for Codex

Long-term memory for coding agents: encrypted on your device, stored on Portaldot V3, and yours to move or revoke.

Generated from `integrations/agent-plugin-core`. Edit it there.

## Install

```bash
codex plugin marketplace add Blockchain-Oracle/memdot
codex plugin add memdot@memdot-plugins
```

Codex's CLI runs hooks from its own config, not from plugins, so one more step adds them there. Start Codex once so the plugin is in place, then:

```bash
node "$HOME/.memdot/bin/memdot-plugin.mjs" setup codex
```

Then open `/hooks` in Codex and trust MemDot's hooks. Codex skips any hook you haven't reviewed.

Needs Node 22.12 or later. The first session unpacks the MemDot CLI into `~/.memdot`.

## Connect

Run the MemDot login skill, or `memdot login`. You approve it in your browser and choose which spaces this agent can reach. Private namespaces stay encrypted: this machine decrypts them with the agent's own key.

## What it does here

- The first prompt of a session searches this repository's memories and adds what it finds.
- Every tool call is noted locally, with secrets removed and no file contents.
- Every 10 turns, at compaction and at the end of a session, the conversation is saved in the background.
- Skills: `memdot-search`, `memdot-remember`, `memdot-forget`, `memdot-status`, `memdot-pause`, `memdot-resume`, `memdot-login`.
- The full MemDot MCP server. Codex has no plugin options, so settings come from `MEMDOT_*` environment variables.
- No sidekick agent: Codex plugins can't carry agent definitions.
