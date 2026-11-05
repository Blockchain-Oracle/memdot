# TypeScript SDK

`@memdot/sdk`, Node 22.12 or newer and browsers. The packages aren't on npm yet, so depend on them from a clone of [the repository](https://github.com/Blockchain-Oracle/memdot) with a pnpm workspace, or point at its packages by path.

## Connect

```ts
import { MemDot } from "@memdot/sdk";
import { connectFromMachine } from "@memdot/sdk/credentials";

// Flags, then the environment, then what `memdot login` saved.
const { memdot, resolved } = await connectFromMachine("my-app");

// Or by hand: an API key alone reaches Assisted memories.
const client = MemDot.create({ baseUrl: "https://api.84.46.247.92.sslip.io", apiKey: process.env.MEMDOT_API_KEY, client: "my-app" });

// A connected agent also holds keys for what it was given: files and Private namespaces.
client.connectAgent({ apiKey, identity });
```

`@memdot/sdk/credentials` is Node only. In a browser, use `memdot.account` to sign in and unlock, with a Worker-backed `embedder` for Private search.

## Memories: `memdot.memories`

| Call | Notes |
|---|---|
| `add(textOrMessages, options)` | Options: `userId`, `agentId`, `runId`, `namespaceId`, `infer`, `metadata`, `expirationDate`, `timestamp`, `memoryType: "procedural_memory"`, `prompt`, `categories`, `immutable`, `idempotencyKey`, `source`, `wait`. Returns `{ eventId, status, namespaceId, results, duplicates, note }` |
| `search(query, options)` | `namespaceId`, `filters`, `topK`, `threshold`, `mode: "hybrid" \| "semantic" \| "keyword"`, `rerank`, `showExpired`, `referenceDate` |
| `list(options)` | `namespaceId`, `filters`, `showExpired`, `cursor`, `pageSize`. Newest first. Returns `{ results, count, nextCursor }` |
| `get(id)`, `update(id, { text, metadata, expirationDate })`, `delete(id)`, `history(id)` | An update writes a new version and keeps the old one in history |
| `deleteAll({ userId, agentId, runId, namespaceId })` | Needs a scope |
| `namespaces(spaceId?)`, `createNamespace({ spaceId, name, mode })` | The mode can't change afterwards |
| `entities(options)`, `deleteEntity(type, id, options)` | The users, agents and runs memories are about |
| `event(id)`, `waitForEvent(id, "indexed" \| "chain")` | Follow a write |
| `exportMemories(namespaceId)`, `importMemories(namespaceId, file)`, `restore(namespaceId)` | `restore` rebuilds search from the chain |
| `setModels(change)`, `setPrivateModel(llm)`, `testModels()` | Assisted's model, and Private's, sealed to your own key |

`add` waits for `"indexed"` by default. `wait: "chain"` waits for finality, and `wait: false` returns at once.

## Files: `memdot.files`

`put(bytes, { spaceId, folderId, name, mime, previousVersionId, wait, wallet, idempotencyKey })`, `putMany`, `get`, `info`, `list({ spaceId, folderId, limit, cursor })`, `rename`, `delete`, `versions`, `verify`, `estimate`, `renew`.

Files up to 64 KiB go into a segment, one blob on chain. Larger ones become 7 MB chunks and a sealed manifest. Self-signed spaces take a `wallet` that signs every store.

## Spaces, folders, sharing, jobs

`memdot.spaces`, `memdot.folders`, `memdot.sharing` (`shareFile`, `shareSpace`, `revoke`, `list`, `open`), `memdot.jobs` (`get`, `waitFor`), `memdot.keys` and `memdot.agents`. Revoking a share moves the space to a new key epoch, so the recipient can't read what comes next.

## Errors

`MemDotError` has a stable `code`, a `status`, a `message` for people and a `requestId`. `LockedError` means the operation needs keys this client doesn't hold. Common codes: `SCOPE_REQUIRED`, `MODEL_REQUIRED`, `PRIVATE_NAMESPACE`, `QUOTA_EXCEEDED`, `KEY_BEHIND`, `NOT_FOUND`.

## Shared memory for your own loop

`AgentMemory` is what the adapters use. It frames recalled memories as notes, never fails a model call over a memory problem, and falls back to storing as written when Private has no model.

```ts
import { AgentMemory } from "@memdot/sdk";

const memory = new AgentMemory(memdot, { userId: "priya", topK: 5 });
const notes = await memory.recall(question);        // string or null, never throws
await memory.saveExchange(question, answer);        // never throws
const hits = await memory.search(question);         // throws, for a tool to report
await memory.remember("Priya prefers tea");         // stored as written
```
