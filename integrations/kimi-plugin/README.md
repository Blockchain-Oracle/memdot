# MemDot for Kimi Code

Long-term memory for coding agents: encrypted on your device, stored on Portaldot V3, and yours to move or revoke.

Generated from `integrations/agent-plugin-core`. Edit it there.

## Install

In Kimi Code:

```text
/plugins install https://app.84.46.247.92.sslip.io/plugins/memdot-kimi.zip
```

Kimi can't install from a folder inside a repository, so this is a zip of this folder, served from the MemDot site. From a clone, `/plugins install /absolute/path/to/integrations/kimi-plugin` works too.

Needs Node 22.12 or later. The first session unpacks the MemDot CLI into `~/.memdot`.

## Connect

Run the MemDot login skill, or `memdot login`. You approve it in your browser and choose which spaces this agent can reach. Private namespaces stay encrypted: this machine decrypts them with the agent's own key.

## What it does here

- The first prompt of a session searches this repository's memories and adds what it finds.
- Every tool call is noted locally, with secrets removed and no file contents.
- Every 10 turns, at compaction and at the end of a session, the conversation is saved in the background.
- `/skill:memdot:search`, `remember`, `forget`, `status`, `pause`, `resume` and `login`.
- The `sidekick` agent, and the full MemDot MCP server. Kimi has no plugin options, so settings come from `MEMDOT_*` environment variables.
