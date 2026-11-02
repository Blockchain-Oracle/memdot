# MemDot for Python

Encrypted storage and agent memory on Portaldot V3. Everything is sealed on your machine with the same
formats as the TypeScript SDK and the dashboard, so a file uploaded in one opens in the other.

```bash
pip install "memdot[local] @ git+https://github.com/Blockchain-Oracle/memdot.git#subdirectory=python/memdot"
```

## Remember and recall

Connect once, and approve in your browser what this machine can reach:

```bash
memdot login
```

```python
from memdot import MemDot

memdot = MemDot.from_credentials()
memdot.add("Priya prefers tea", user_id="priya")
for hit in memdot.search("what does Priya drink?", user_id="priya"):
    print(hit.memory, hit.score)
```

`AsyncMemDot` is the same client with `await`. Without `memdot login`, pass a key from the dashboard:
`MemDot("md_…")`, or set `MEMDOT_API_KEY`.

A Private namespace runs on this machine: MemDot only sees ids and ciphertext. An Assisted one lets the
server read text, to extract facts and search. You choose per namespace, with the same calls.

## Files

```python
stored = memdot.files.put(data, space_id=space.id, name="report.pdf")
memdot.files.get(stored.file.id).data
memdot.files.verify(stored.file.id).ok  # asks Portaldot V3 directly, never MemDot
```

## What's in the box

| Part | Use | Install |
|---|---|---|
| `MemDot`, `AsyncMemDot` | account, spaces, folders, files, sharing, jobs, keys, agents, memories, data, usage, activity, proof | included |
| `memdot` command | the same commands, flags, JSON and exit codes as the Node CLI, and the same credentials file | included |
| Searching Private by meaning | all-MiniLM-L6-v2, on this machine. Without it, search goes by words | `memdot[local]` |
| Registry records as the owner | the public record of what an account stores | `memdot[owner]` |
| `memdot mcp` | the local MCP server, which reads Private namespaces | `memdot[mcp]` |
| `memdot.integrations.langgraph` | `MemDotStore` for LangGraph, and tools for LangChain | `memdot[langgraph]` |
| `memdot.integrations.crewai` | remember and recall tools | `memdot[crewai]` |
| `memdot.integrations.strands` | `MemDotMemoryStore`, and a `memdot_memory` tool | `memdot[strands]` |
| `memdot.integrations.openai_agents` | tools, and `MemDotSession` for transcripts | `memdot[openai-agents]` |

## Coming from another memory product

The usual verbs are on the client itself, and results answer to `hit["memory"]` as well as `hit.memory`:
`add`, `search`, `get_all`, `get`, `update`, `delete`, `delete_all`, `history`. Bring old memories over
with `memdot import export.json`.

## What stays in the browser or the TypeScript SDK

- Passkeys and browser wallets need a browser. From Python, sign in with the recovery code or a script
  `Wallet`, or connect as an agent.
- Self-signed spaces need a wallet to sign each `store` with Portaldot's runtime types, which this
  package doesn't carry. Reading them works; writing asks you to use the dashboard or TypeScript.

## Developing

```bash
uv sync --extra local --extra mcp
uv run pytest
uv run python scripts/unasync.py   # after changing src/memdot/_async: _sync is generated from it
```

`tests/vectors` holds what TypeScript sealed for Python to open, and what Python sealed for TypeScript
to open. `pnpm --filter @memdot/sdk vectors:python` writes the first half, and `MEMDOT_WRITE_VECTORS=1
uv run pytest` the second.
