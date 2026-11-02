---
name: search
description: Search what MemDot remembers about this repository and this user.
argument-hint: "[question] [--scope repo|mine|all] [--top-k n]"
disable-model-invocation: true
---

# Search MemDot

{{ARGUMENTS}}

Run this with the question in place of QUESTION, and give back what it prints as it is:

```bash
{{MEMDOT}} search <<'MEMDOT_END'
QUESTION
MEMDOT_END
```

`--scope` and `--top-k` go after `search`. Without them it uses the configured defaults.

- `repo`: this repository's memories, plus the user's own preferences from anywhere.
- `mine`: everything saved for this user, in any repository.
- `all`: the whole namespace.

If it says nothing was found, say that. If it reports an error about a key or a connection, say memory isn't reachable, not that nothing is remembered.
