# TypeScript SDK

`@memdot/sdk`, Node 22.12 or newer and browsers.

The TypeScript packages aren't on npm yet, and they depend on each other through a pnpm workspace, so today they only resolve inside a clone of [the repository](https://github.com/Blockchain-Oracle/memdot): put your code in its `examples/` folder, or add it to `pnpm-workspace.yaml`. In a project that has to stay outside, call the [REST API](rest.md) with `fetch`, or use Python, which installs from git.

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

`@memdot/sdk/credentials` is Node only.

**In a browser,** a page on your own address connects the way the CLI does: it makes a key pair with `newAgentIdentity()`, asks with `memdot.agents.startConnect`, polls with `pollConnect` while the person approves in their dashboard, and then calls `connectAgent`. Pass `credentials: "omit"` for the requests made before there's a key. Sessions, and so `memdot.account`, only work on the dashboard's own address. For Private search, pass a Worker-backed `embedder`. See [`examples/file-vault`](https://github.com/Blockchain-Oracle/memdot/tree/main/examples/file-vault) and [`examples/private-notes`](https://github.com/Blockchain-Oracle/memdot/tree/main/examples/private-notes).

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

`AgentMemory` is what the adapters use. It frames recalled memories as notes, and gives memory 8 seconds (`timeoutMs`) before the model goes ahead without it. Past that, or on any failure, `recall` and `saveExchange` report through `onError` rather than throwing. A Private namespace with no model saves nothing unless you pass `whenNoModel: "as-written"`, which keeps each message exactly as typed.

```ts
import { AgentMemory } from "@memdot/sdk";

const memory = new AgentMemory(memdot, { userId: "priya", topK: 5 });
const notes = await memory.recall(question);        // string or null, never throws
await memory.saveExchange(question, answer);        // never throws
const hits = await memory.search(question);         // throws, for a tool to report
await memory.remember("Priya prefers tea");         // stored as written
```
