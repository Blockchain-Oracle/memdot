# MemDot for Claude Code

Long-term memory for coding agents: encrypted on your device, stored on Portaldot V3, and yours to move or revoke.

Generated from `integrations/agent-plugin-core`. Edit it there.

## Install

```bash
claude plugin marketplace add Blockchain-Oracle/memdot
claude plugin install memdot@memdot-plugins
```

Needs Node 22.12 or later. The first session unpacks the MemDot CLI into `~/.memdot`.

## Connect

Run the MemDot login skill, or `memdot login`. You approve it in your browser and choose which spaces this agent can reach. Private namespaces stay encrypted: this machine decrypts them with the agent's own key.

## What it does here

- The first prompt of a session searches this repository's memories and adds what it finds.
- Every tool call is noted locally, with secrets removed and no file contents.
- Every 10 turns, at compaction and at the end of a session, the conversation is saved in the background.
- `/memdot:search`, `/memdot:remember`, `/memdot:forget`, `/memdot:status`, `/memdot:pause`, `/memdot:resume`, `/memdot:login`.
- The `memdot:sidekick` agent does bounded work on a cheaper model in its own worktree, starting from what was recalled.
- The full MemDot MCP server, for memories and encrypted files.
