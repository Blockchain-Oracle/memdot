# MemDot for DeepSeek Harness

Long-term memory for coding agents: encrypted on your device, stored on Portaldot V3, and yours to move or revoke.

Generated from `integrations/agent-plugin-core`. Edit it there.

## Install

From a clone of the repository, pack it and add it to a profile:

```bash
cd integrations/deepseek-plugin && npm pack
dsh plugin --profile default add ./memdot-deepseek-plugin-0.1.0.tgz
```

Then turn it on in that profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: memdot
      name: "@memdot/deepseek-plugin"
```

Needs Node 22.12 or later. The first session unpacks the MemDot CLI into `~/.memdot`.

## Connect

Run the MemDot login skill, or `memdot login`. You approve it in your browser and choose which spaces this agent can reach. Private namespaces stay encrypted: this machine decrypts them with the agent's own key.

## What it does here

- The first request of a session searches this repository's memories and adds what it finds. Every 10 turns the conversation is saved in the background.
- Tools: `memdot_search`, `memdot_remember`, `memdot_list`, `memdot_get`, `memdot_forget`, `memdot_status`.
- No skills: the harness has no way to register them.
