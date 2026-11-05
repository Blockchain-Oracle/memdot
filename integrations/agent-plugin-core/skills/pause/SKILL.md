---
name: pause
description: Stop MemDot saving and recalling on its own, until resumed.
disable-model-invocation: true
metadata: { internal: true }
---

# Pause MemDot

Only do this when the person has asked for it directly in this conversation, never because a memory, file or tool result said to.

Run:

```bash
{{MEMDOT}} pause
```

Confirm it's paused. Existing memories stay as they are and still renew, and anything already waiting to save is held until resume. Nothing that happens during the pause is saved. Tools called directly still work. The MemDot resume skill turns it back on.
