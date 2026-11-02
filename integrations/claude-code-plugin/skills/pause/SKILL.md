---
name: pause
description: Stop MemDot saving and recalling on its own, until resumed.
disable-model-invocation: true
---

# Pause MemDot

Run:

```bash
node "$HOME/.memdot/bin/memdot-plugin.mjs" pause
```

Confirm it's paused. Existing memories stay as they are and still renew, and anything already waiting to save is held until resume. Nothing that happens during the pause is saved. Tools called directly still work. The MemDot resume skill turns it back on.
