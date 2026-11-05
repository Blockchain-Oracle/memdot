# Every memdot command

Generated from `memdot help --json` by `scripts/skills-cli-reference.mjs`. Don't edit by hand.

## Options on every command

| Option | What it does |
|---|---|
| `-v, --version` | this CLI's version |
| `--agent` | answer as one JSON envelope on stdout, for agents and scripts |
| `--json` | the same as --agent |
| `-o, --output <mode>` | how to answer |
| `--api-key <key>` | use this key (or MEMDOT_API_KEY) |
| `--api-url <url>` | use this API (or MEMDOT_API_URL) |
| `-n, --namespace <id>` | which namespace (or MEMDOT_NAMESPACE) |
| `-u, --user-id <id>` | who this is about (or MEMDOT_USER_ID) |
| `--agent-id <id>` | which agent this belongs to (or MEMDOT_AGENT_ID) |
| `--run-id <id>` | which session or run (or MEMDOT_RUN_ID) |

## `memdot add [text]`

Remember something

| Option | What it does |
|---|---|
| `--messages <json>` | a conversation, as a JSON array of {role, content} |
| `-f, --file <path>` | read the conversation from a JSON file |
| `-m, --metadata <json>` | metadata to keep with it |
| `--no-infer` | store it exactly as written, without a model |
| `--procedural` | keep this as an agent's working record |
| `--immutable` | never let it change |
| `--expires <date>` | when it stops counting (YYYY-MM-DD) |
| `--timestamp <time>` | when it happened (ISO time or unix seconds) |
| `--prompt <text>` | custom instructions, for this call only |
| `--categories <json>` | categories to file under, as a JSON array of {name, description} |
| `--idempotency-key <key>` | sent again with the same key, it isn't saved twice |
| `--wait-chain` | wait until it's finalized on Portaldot V3 |
| `--no-wait` | return at once with an event to follow |

## `memdot search [query]`

Find what's been remembered, by meaning and keyword

| Option | What it does |
|---|---|
| `-k, --top-k <n>` | how many results |
| `--threshold <n>` | minimum similarity, 0 to 1 |
| `--keyword` | match words only |
| `--semantic` | match meaning only |
| `--rerank` | let the model put the best first |
| `--filter <json>` | for example {"AND":[{"user_id":"priya"}]} |
| `--show-expired` | include what has expired |
| `--reference-date <date>` | search as of this moment |
| `--fields <list>` | only these fields, comma separated |

## `memdot list`

List memories, newest first

| Option | What it does |
|---|---|
| `--page-size <n>` | how many at a time |
| `--cursor <cursor>` | next_cursor from the page before |
| `--category <name>` | only this category |
| `--after <date>` | created after this date |
| `--before <date>` | created before this date |
| `--filter <json>` | for example {"user_id":"priya"} |
| `--show-expired` | include what has expired |

## `memdot get <id>`

Read one memory

## `memdot update <id> [text]`

Correct a memory; the old version stays in its history

| Option | What it does |
|---|---|
| `-m, --metadata <json>` | metadata to merge in |
| `--expires <date>` | when it stops counting (YYYY-MM-DD) |

## `memdot delete [id]`

Forget a memory, or everything in a scope

| Option | What it does |
|---|---|
| `--all` | everything in the given scope (-u, --agent-id or --run-id) |
| `--dry-run` | say what would go, and change nothing |
| `--force` | don't ask |

## `memdot history <id>`

How a memory changed

## `memdot import <file>`

Bring memories in from a MemDot or Mem0 export

| Option | What it does |
|---|---|
| `--source <name>` | where these came from |

## `memdot export`

Write a namespace's memories out as JSON, decrypted here

| Option | What it does |
|---|---|
| `--out <file>` | where to write it (default: stdout) |

## `memdot restore`

Rebuild a namespace's search from the chain

## `memdot file`

Encrypted files on Portaldot V3

### `memdot file put <path>`

Encrypt a file here and store it

| Option | What it does |
|---|---|
| `--space <id>` | which space (default: the only one you can reach) |
| `--folder <id>` | which folder |
| `--name <name>` | what to call it (default: the file's own name) |
| `--mime <type>` | its type |
| `--replaces <id>` | store this as a new version of that file |
| `--dry-run` | say what it would cost, and store nothing |
| `--no-wait` | return once it's queued, before it's on chain |

### `memdot file get <id>`

Fetch a file and decrypt it here

| Option | What it does |
|---|---|
| `-O, --out <path>` | where to write it (default: its own name) |
| `--stdout` | write the bytes to stdout |

### `memdot file ls`

List files, names decrypted here

| Option | What it does |
|---|---|
| `--space <id>` |  |
| `--folder <id>` |  |
| `--limit <n>` | how many |
| `--cursor <cursor>` |  |

### `memdot file verify <id>`

Check a file against the chain, from this machine

### `memdot file share [id]`

Share a file or a space, which takes the owner's keys

| Option | What it does |
|---|---|
| `--space <id>` | share this whole space instead |
| `--to <address>` | someone's Portaldot or EVM address |
| `--to-agent <id>` | a connected agent |
| `--scope <scope>` | read or read_write |
| `--expires-days <n>` | stop working after this many days |

### `memdot file revoke <grantId>`

Stop a share; future writes use a key they never get

| Option | What it does |
|---|---|
| `--force` | don't ask |

### `memdot file rm <id>`

Delete a file; its bytes leave the chain within 7 days

| Option | What it does |
|---|---|
| `--force` | don't ask |

### `memdot file renew <id>`

Renew a file now, without waiting for the keeper

| Option | What it does |
|---|---|
| `--no-wait` | return once it's queued |

### `memdot file versions <id>`

Every version of a file

## `memdot space`

Spaces: where files and namespaces live

### `memdot space ls`

List the spaces this key can reach

### `memdot space get <id>`

Read one space

### `memdot space create <name>`

Create a space, which takes the owner's keys

| Option | What it does |
|---|---|
| `--self-signed` | your wallet signs each store |

### `memdot space rename <id> <name>`

Rename a space

### `memdot space rm <id>`

Delete a space and everything in it

| Option | What it does |
|---|---|
| `--force` | don't ask |

## `memdot folder`

Folders inside a space

### `memdot folder ls`

List folders in a space

| Option | What it does |
|---|---|
| `--space <id>` |  |

### `memdot folder create <name>`

Create a folder; its name is sealed here

| Option | What it does |
|---|---|
| `--space <id>` |  |
| `--parent <id>` |  |

### `memdot folder rename <id> <name>`

Rename a folder

| Option | What it does |
|---|---|
| `--space <id>` |  |

### `memdot folder rm <id>`

Delete a folder

| Option | What it does |
|---|---|
| `--force` | don't ask |

## `memdot namespace`

Where memories live

### `memdot namespace ls`

List namespaces

| Option | What it does |
|---|---|
| `--space <id>` |  |

### `memdot namespace create <name>`

Create a namespace; its mode can't change afterwards

| Option | What it does |
|---|---|
| `--mode <mode>` | private: only devices with the key read it. assisted: the server reads text. |
| `--space <id>` |  |

## `memdot entity`

The users, agents and runs memories are about

### `memdot entity ls`

List them, with how many memories each has

### `memdot entity rm <type> <id>`

Forget one and all its memories

| Option | What it does |
|---|---|
| `--dry-run` | say what would go, and change nothing |
| `--force` | don't ask |

## `memdot event`

Memory operations

### `memdot event ls`

Recent writes, and whether each finished

| Option | What it does |
|---|---|
| `--limit <n>` | how many |

### `memdot event get <id>`

One operation: whether it's indexed, and on the chain

## `memdot job`

Storage jobs

### `memdot job ls`

Recent jobs

| Option | What it does |
|---|---|
| `--status <status>` |  |
| `--limit <n>` | how many |

### `memdot job get <id>`

One job

### `memdot job wait <id>`

Wait until a job finishes

## `memdot agents`

Connected agents; managing them takes an account-wide management key

### `memdot agents ls`

List connected agents

### `memdot agents rename <id> <label>`

Rename a connected agent

### `memdot agents revoke <id>`

Stop an agent now: its keys and tokens stop working, and its spaces change key

| Option | What it does |
|---|---|
| `--force` | don't ask |

## `memdot keys`

API keys; managing them takes an account-wide management key

### `memdot keys ls`

List API keys

### `memdot keys create <name>`

Make a key. It's shown once, here

| Option | What it does |
|---|---|
| `--role <role>` | read_only, read_write, management |
| `--space <id...>` | limit it to these spaces |
| `--expires-days <n>` | stop working after this many days |

### `memdot keys rotate <id>`

Revoke a key and make a new one with the same name, role and spaces

| Option | What it does |
|---|---|
| `--force` | don't ask |

### `memdot keys revoke <id>`

Revoke a key

| Option | What it does |
|---|---|
| `--force` | don't ask |

## `memdot usage`

Storage, renewals and shared-model allowance

## `memdot logs`

Recent API requests: metadata only, never bodies

| Option | What it does |
|---|---|
| `--limit <n>` | how many |

## `memdot login`

Connect this machine: you choose what it can reach, in your browser

| Option | What it does |
|---|---|
| `--label <name>` | what to call it |
| `--with-key <key>` | use an API key you already have (Assisted only, no browser) |
| `--no-browser` | just print the address |
| `--no-wait` | print the address and return; finish later with --continue |
| `--continue` | collect a login started with --no-wait |
| `--wait <seconds>` | how long --continue waits |
| `--print-env` | connect somewhere else: print its credentials, and save nothing here |

## `memdot init`

Set up this machine: the same as login, or --api-key to use a key you have

## `memdot logout`

Forget this machine's key. It keeps working elsewhere until you revoke it

## `memdot whoami`

Who this machine is connected as

## `memdot status`

Whether MemDot is reachable and this key works

## `memdot version`

This CLI's version

## `memdot config`

What's saved on this machine

### `memdot config show`

Show it, with keys hidden

### `memdot config get <key>`

Read one setting

### `memdot config set <key> <value>`

Save one setting

## `memdot mcp`

Run the local MCP server over stdio, or set a client up to use it

### `memdot mcp config`

What a client needs to use MemDot; --write adds it to the client's settings

| Option | What it does |
|---|---|
| `--client <name>` | claude-code, claude-desktop, cursor |
| `--hosted` | the hosted server: Assisted namespaces, signs in with OAuth |
| `--write` | add it to that client's settings file |
