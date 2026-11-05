---
name: status
description: Check whether MemDot memory is connected and saving in this repository.
metadata: { internal: true }
---

# MemDot status

Run:

```bash
{{MEMDOT}} status
```

Sum up only what it reports, in a few lines. In particular:

- `connected: false`: nothing is being saved or recalled. Point to the MemDot login skill.
- `key_works: false`: the key was revoked or has expired, so memories are not being saved. Say that plainly, and don't report it as "no memories found".
- `paused: true`: the MemDot resume skill turns it back on.
- `waiting_to_save` above 0: those are safe on this machine and go out when `waiting_reason` clears.
- `could_not_save` above 0: those gave up after repeated failures, and are kept in `~/.memdot/plugin/failed` for a while.
- `mode`: `private` means memories are encrypted and processed on this machine. `assisted` means the server reads them to extract and search.
