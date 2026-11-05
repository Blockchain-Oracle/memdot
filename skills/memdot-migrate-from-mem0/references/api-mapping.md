# Mem0 to MemDot

Check each call against the SDK you're moving to. This maps what each one does, and arguments that aren't listed have no equivalent.

## Python

| Mem0 | MemDot |
|---|---|
| `from mem0 import MemoryClient` | `from memdot import MemDot` |
| `MemoryClient(api_key=…)` | `MemDot("md_…")`, or `MemDot.from_credentials()` after `memdot login` |
| `AsyncMemoryClient` | `AsyncMemDot` |
| `client.add(messages, user_id="alex")` | `memdot.add(messages, user_id="alex")` |
| `client.add(…, infer=False)` | `memdot.add(…, infer=False)` |
| `client.search(q, filters={"user_id": "alex"})["results"]` | `memdot.search(q, filters={"user_id": "alex"})`, which is already the list |
| `client.get_all(filters=…)["results"]` | `memdot.get_all(filters=…).results` |
| `client.get(id)` | `memdot.get(id)` |
| `client.update(id, text=…)` | `memdot.update(id, text=…)` |
| `client.delete(id)` | `memdot.delete(id)` |
| `client.delete_all(user_id=…)` | `memdot.delete_all(user_id=…)` |
| `client.history(id)` | `memdot.history(id)` |

## TypeScript

| Mem0 | MemDot |
|---|---|
| `import MemoryClient from "mem0ai"` | `import { connectFromMachine } from "@memdot/sdk/credentials"` |
| `new MemoryClient({ apiKey })` | `(await connectFromMachine("my-app")).memdot` |
| `client.add(messages, { user_id })` | `memdot.memories.add(messages, { userId })` |
| `client.search(q, { filters })` | `memdot.memories.search(q, { filters })`. Filter fields stay snake_case |
| `client.getAll({ filters })` | `memdot.memories.list({ filters })`, which returns `{ results, nextCursor }` |
| `client.get(id)`, `client.delete(id)`, `client.history(id)` | `memdot.memories.get(id)`, `.delete(id)`, `.history(id)` |
| `client.update(id, { text })` | `memdot.memories.update(id, { text })` |
| `client.deleteAll({ user_id })` | `memdot.memories.deleteAll({ userId })` |

Results use camelCase in TypeScript (`userId`, `createdAt`) and keep `memory` and `score`.

## REST

| Mem0 | MemDot |
|---|---|
| `Authorization: Token m0-…` | `Authorization: Bearer md_…` |
| `POST /v3/memories/add/` | `POST /v1/memories` |
| `POST /v3/memories/search/` | `POST /v1/memories/search` |
| `POST /v3/memories/` | `POST /v1/memories/list` |
| `GET /v1/event/{id}/` | `GET /v1/memories/events/{id}` |

## Frameworks

| Mem0 | MemDot |
|---|---|
| `@mem0/vercel-ai-provider`: `createMem0()` | `@memdot/ai-sdk`: `createMemDot().wrap(anyModel, { userId })` |
| Mem0's MCP server | `memdot mcp` (local), or the hosted server at `/mcp` |
| n8n and Zapier nodes | `integrations/n8n-nodes-memdot`, `integrations/zapier-memdot` |

## What changes meaning

| Mem0 | MemDot |
|---|---|
| `org_id`, `project_id` | A space and a namespace. Pass `namespace_id` |
| `app_id` | No such scope. Use `agent_id` or `metadata` |
| An API key reaches everything | An API key reaches Assisted memories. Files and Private namespaces also need an agent identity |
| `filters` with `AND`, `OR`, `NOT` | The same grammar |
| `immutable`, `expiration_date`, `custom_instructions`, `custom_categories`, `timestamp` | Available, with `custom_instructions` as `prompt` in an add call, or set on the namespace |

## What doesn't carry over

- **Memory IDs.** Imported memories get new IDs. If the app stores Mem0 IDs, keep a mapping or look memories up by metadata instead.
- **Graph relations.** Only the memories themselves are imported.
- **Webhooks, feedback history and exports already requested** stay with the old service.

## What's new

- **Every memory is stored encrypted on Portaldot V3**, and `memdot restore` rebuilds search from the chain.
- **Private namespaces**, where the server never sees the text.
- **Encrypted files next to memories**, shared with the same agents.
