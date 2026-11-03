---
name: memdot-login
description: Connect this machine to MemDot so memories can be saved and recalled.
---

# Connect MemDot

The person has to approve this in their browser; you can't do it for them.

1. Run this and show them the address and the code it prints, exactly:

   ```bash
   node "$HOME/.memdot/bin/memdot-plugin.mjs" login --client "Codex"
   ```

2. Tell them to open the address, type the code, and choose what this agent can reach. Then run this, which waits for them, up to about 100 seconds at a time:

   ```bash
   node "$HOME/.memdot/bin/memdot-plugin.mjs" login --continue
   ```

   If it says it's still waiting, run it again. Only ask them to start over if they say the code expired.

3. When it says connected, tell them to restart this session or reload plugins, so the MemDot tools come up. Saving and recall start from the next session.

4. Codex's CLI only runs hooks from its own config, so add MemDot's there, and tell them to open `/hooks` once and trust them:

   ```bash
   node "$HOME/.memdot/bin/memdot-plugin.mjs" setup codex
   ```
