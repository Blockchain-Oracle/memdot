---
name: memdot-cli
description: >
  Use the memdot command line: remember, search and forget from a terminal or script, encrypted files
  on Portaldot V3, spaces, namespaces, agents and keys, with a JSON envelope and distinct exit codes
  for agents.
  TRIGGER when: the user asks for a memdot command, wants to script MemDot in a shell, or an agent
  needs to read or write MemDot from a terminal.
  DO NOT TRIGGER when: the code calls an SDK (use memdot), or the user wants a project wired up (use
  memdot-integrate).
license: Apache-2.0
metadata:
  author: Blockchain-Oracle
  version: 0.1.3
  category: ai-memory
---

# The memdot CLI

## Install and connect

```bash
npm install -g https://app.84.46.247.92.sslip.io/cli/memdot-cli.tgz
memdot login
```

`memdot login` prints an address and a code, then opens your browser. There you type the code and choose which spaces this machine can reach. In an agent's shell, where a command's output only shows once it ends, use the two-step form and pass the address on to the person:

```bash
memdot login --no-wait
memdot login --continue --wait 120
```

| To | Run |
|---|---|
| Connect somewhere else (a server, CI, n8n), saving nothing here | `memdot login --print-env --label name` |
| Use a dashboard key (Assisted only, no browser) | `memdot login --with-key md_…` or `MEMDOT_API_KEY` |
| See what you're connected as | `memdot whoami`, `memdot status` |

Python's `memdot` has the same commands, flags, JSON and exit codes, and reads the same credentials file.

## Remember, find, correct, forget

```bash
memdot add "Alex deploys on Fridays" -u alex --no-infer
memdot search "when does Alex deploy?" -u alex
memdot list -u alex
memdot update <id> "Alex deploys on Thursdays now"
memdot history <id>
memdot delete <id> --force
memdot delete --all -u alex --dry-run
```

`--no-infer` stores the text as written and spends no model call. Without it, a model distills facts and may find none. Pass the scope on every search, or it looks across everyone.

## For agents and scripts

Add `--agent` (or `--json`) anywhere: stdout holds exactly one JSON envelope, and progress stays on stderr.

```bash
memdot --agent search "when does Alex deploy?" -u alex --fields id,memory,score | jq -r '.data[].memory'
```

```json
{ "status": "success", "command": "search", "duration_ms": 412, "scope": { "userId": "alex" }, "count": 1, "data": [] }
{ "status": "error", "command": "get", "error": { "code": "NOT_FOUND", "message": "Memory not found.", "request_id": "…" }, "data": null }
```

Note the shapes: `search` puts results directly in `data`, `list` in `data.results` with `data.next_cursor`, and `file ls` in `data.files`.

| Exit | Means | Do |
|---|---|---|
| 0 | It worked | |
| 1 | Something else failed | Read `error.message` |
| 2 | Bad usage | Fix the command |
| 3 | Not connected, or the key stopped working | `memdot login` |
| 4 | Not found | |
| 5 | Conflict, or a confirmation is needed | Pass `--force` only if the person asked for it |
| 6 | Over a limit | Wait, or see `memdot usage` |
| 7 | Network | Try again |

Anything that can't be undone asks first, or needs `--force` when no person is there.

`memdot help --json` describes every command for an agent to read.

## Files

```bash
memdot file put ./notes.pdf --space <id> --dry-run
memdot file put ./notes.pdf --space <id>
memdot file ls --space <id>
memdot file verify <id>
memdot file get <id> --out notes.pdf
memdot file share <id> --to <address>
memdot file rm <id> --force
```

`verify` asks Portaldot V3 from this machine, never MemDot. `--dry-run` says what a store would cost.

## Everything else

The full list, generated from the CLI itself, is in [references/commands.md](references/commands.md). Look there rather than guessing a flag.
