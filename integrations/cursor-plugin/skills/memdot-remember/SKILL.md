---
name: memdot-remember
description: Save one fact to MemDot right now, exactly as given.
disable-model-invocation: true
---

# Remember in MemDot

Write the fact so it makes sense on its own later: name things outright, and don't rely on this conversation. Keep what the user said; don't add to it. Then run this with the fact in place of FACT:

```bash
node "$HOME/.memdot/bin/memdot-plugin.mjs" remember <<'MEMDOT_END'
FACT
MEMDOT_END
```

It's saved under this repository and encrypted before it leaves this machine if the namespace is Private. Report the line it prints, and never claim a save that didn't print. It may say it's already remembered, which is fine.
