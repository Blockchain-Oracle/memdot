# MemDot for Antigravity

Long-term memory for coding agents: encrypted on your device, stored on Portaldot V3, and yours to move or revoke.

Generated from `integrations/agent-plugin-core`. Edit it there.

## Install

From a clone of the repository:

```bash
agy plugin install ./integrations/antigravity-plugin
```

Needs Node 22.12 or later. The first session unpacks the MemDot CLI into `~/.memdot`.

## Connect

Run the MemDot login skill, or `memdot login`. You approve it in your browser and choose which spaces this agent can reach. Private namespaces stay encrypted: this machine decrypts them with the agent's own key.

## What it does here

- The first prompt of a session searches this repository's memories and adds what it finds.
- Every tool call is noted locally, with secrets removed and no file contents.
- Every 10 turns the conversation is saved in the background. Antigravity reports no session end, so what's left over goes at the start of the next session.
- `/memdot-search`, `/memdot-remember`, `/memdot-forget`, `/memdot-status`, `/memdot-pause`, `/memdot-resume`, `/memdot-login`.
- The `sidekick` agent, and the full MemDot MCP server.
