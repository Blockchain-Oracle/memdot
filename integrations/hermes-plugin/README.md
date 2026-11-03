# MemDot for Hermes Agent

Long-term memory for coding agents: encrypted on your device, stored on Portaldot V3, and yours to move or revoke.

Generated from `integrations/agent-plugin-core`. Edit it there.

## Install

From a clone of the repository:

```bash
cp -r integrations/hermes-plugin ~/.hermes/plugins/memdot
hermes plugins enable memdot
```

Then choose it with `hermes memory setup memdot`. Hermes runs one memory provider at a time.

Needs Node 22.12 or later. The first session unpacks the MemDot CLI into `~/.memdot`.

## Connect

Run the MemDot login skill, or `memdot login`. You approve it in your browser and choose which spaces this agent can reach. Private namespaces stay encrypted: this machine decrypts them with the agent's own key.

## What it does here

- A Hermes memory provider. Recall happens before the first request of a session, and turns are saved in the background.
- Tools: `memdot_search`, `memdot_remember`, `memdot_forget`, `memdot_status`.
- It calls the same bundled core as every other plugin, by command, so it needs node on the PATH.
