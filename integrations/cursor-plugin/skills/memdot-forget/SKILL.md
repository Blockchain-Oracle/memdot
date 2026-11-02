---
name: memdot-forget
description: Permanently forget memories from MemDot, after confirming with the user.
disable-model-invocation: true
---

# Forget from MemDot

This can't be undone, so go step by step.

1. Find what would go. For something specific, search for it:

   ```bash
   node "$HOME/.memdot/bin/memdot-plugin.mjs" search --scope repo <<'MEMDOT_END'
   WHAT TO FORGET
   MEMDOT_END
   ```

   For everything saved for this repository, count it instead:

   ```bash
   node "$HOME/.memdot/bin/memdot-plugin.mjs" forget --repo
   ```

2. Show the user exactly what would be forgotten, and wait for a clear yes in the conversation. Anything else means stop.

3. Only then run one of these:

   ```bash
   node "$HOME/.memdot/bin/memdot-plugin.mjs" forget ID_ONE ID_TWO --yes
   node "$HOME/.memdot/bin/memdot-plugin.mjs" forget --repo --yes
   ```

Report what it prints. Forgotten memories leave search and renewal right away, but older encrypted copies on the chain expire on their own rather than being erased.
