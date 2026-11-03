---
name: remember
description: Save one fact to MemDot right now, exactly as given.
argument-hint: "[what to remember]"
disable-model-invocation: true
---

# Remember in MemDot

The person asked for: $ARGUMENTS

Write the fact so it makes sense on its own later: name things outright, and don't rely on this conversation. Keep what the user said; don't add to it. Then run this with the fact in place of FACT:

```bash
node "$HOME/.memdot/bin/memdot-plugin.mjs" remember <<'MEMDOT_END'
FACT
MEMDOT_END
```

If the text has a line reading MEMDOT_END, use a different end marker that it doesn't contain.

It's saved under this repository and encrypted before it leaves this machine if the namespace is Private. Report the line it prints, and never claim a save that didn't print. It may say it's already remembered, which is fine.
