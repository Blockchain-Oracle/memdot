# Python SDK

```bash
pip install "memdot[local] @ git+https://github.com/Blockchain-Oracle/memdot.git#subdirectory=python/memdot"
```

Python 3.10 or newer. `[local]` adds searching Private namespaces by meaning, `[mcp]` the local MCP server, and `[owner]` writing registry records as the owner.

## Connect

```python
from memdot import AsyncMemDot, MemDot

memdot = MemDot.from_credentials()   # the environment, then what `memdot login` saved
memdot = MemDot("md_…")              # a dashboard key: Assisted memories only
```

## Memories

The usual verbs are on the client:

```python
memdot.add("Priya prefers tea", user_id="priya")
memdot.add([{"role": "user", "content": "I moved to Lisbon"}], user_id="priya", infer=True)
memdot.search("where does Priya live?", user_id="priya", top_k=5)
memdot.get_all(user_id="priya")
memdot.get(memory_id)
memdot.update(memory_id, text="Priya moved to Porto")
memdot.history(memory_id)
memdot.delete(memory_id)
memdot.delete_all(user_id="priya")
```

`memdot.memories` has the rest under the same names as TypeScript, in snake_case: `namespaces`, `create_namespace`, `entities`, `event`, `wait_for_event`, `export_memories`, `import_memories`, `restore`.

Results answer to `hit.memory` and `hit["memory"]`.

## Files

```python
stored = memdot.files.put(data, space_id=space.id, name="report.pdf")
memdot.files.get(stored.file.id).data
memdot.files.verify(stored.file.id).ok  # asks Portaldot V3 directly
```

## Limits

- Passkeys and browser wallets need a browser. From Python, connect as an agent, or sign in with a recovery code or a script `Wallet`.
- Self-signed spaces can be read but not written from Python, since signing a store needs runtime types this package doesn't carry.
