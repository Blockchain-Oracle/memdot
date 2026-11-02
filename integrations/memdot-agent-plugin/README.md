# MemDot for any Agent Plugins host

Long-term memory for coding agents: encrypted on your device, stored on Portaldot V3, and yours to move or revoke.

Generated from `integrations/agent-plugin-core`. Edit it there.

## Install

Install this folder the way your client installs an Agent Plugins v1 package.

Needs Node 22.12 or later. The first session unpacks the MemDot CLI into `~/.memdot`.

## Connect

Run the MemDot login skill, or `memdot login`. You approve it in your browser and choose which spaces this agent can reach. Private namespaces stay encrypted: this machine decrypts them with the agent's own key.

## What it does here

- The MemDot MCP server and the skills. The standard has no lifecycle hooks, so nothing is recalled or saved on its own: the agent uses the tools.
