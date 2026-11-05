# What fits where

| The project | Use | Where the change goes |
|---|---|---|
| AI SDK | `memdot.wrap(model, { userId })` from `@memdot/ai-sdk` | Where the model is created. Per request, if the user changes per request |
| Next.js route with AI SDK | The same, with `waitUntil: after` from `next/server` | The route handler, so saving doesn't hold up the stream |
| LangChain `createAgent` (TypeScript) | `memdotMiddleware()` from `@memdot/langchain`, with `context: { userId }` on each invoke | The `middleware` list |
| LangGraph (TypeScript or Python) with a store | `MemDotStore` | `compile({ store })` |
| Mastra | `MemDotMemory` | `inputProcessors` and `outputProcessors` |
| CrewAI, Strands, OpenAI Agents (Python) | `memdot.integrations.*` tools | The agent's `tools` |
| Any OpenAI client, on the server, Assisted is fine | `/v1/chat/completions` with `user_id` | Change the base URL and add one field |
| Your own loop | `AgentMemory` (TypeScript), or `search` and `add` (Python) | Around the model call |
| An MCP-capable agent | `memdot mcp` | The client's config |
| A browser app holding its own keys | `@memdot/sdk` with a Worker-backed embedder | See `examples/private-notes` |

## A Next.js route, in full

```ts
import { google } from "@ai-sdk/google";
import { createMemDot } from "@memdot/ai-sdk";
import { convertToModelMessages, streamText } from "ai";
import { after } from "next/server";

const memdot = createMemDot();

export async function POST(request: Request) {
  const { messages } = await request.json();
  const userId = await currentUserId(request); // from your own session, never from the request body
  const model = memdot.wrap(google("gemini-2.5-flash"), { userId, waitUntil: after });
  return streamText({ model, messages: await convertToModelMessages(messages) }).toUIMessageStreamResponse();
}
```

## The test, in outline

```ts
const word = `zebra-${crypto.randomUUID().slice(0, 8)}`;
await askTheApp(alice, `Please remember my locker code word is ${word}.`);
await until(async () => (await memory(alice).search("locker code word")).some((hit) => hit.memory.includes(word)));
expect(await askTheApp(alice, "What's my locker code word?", { newSession: true })).toContain(word);
expect(await askTheApp(bob, "What's my locker code word?", { newSession: true })).not.toContain(word);
```

A word no model could guess is the point: an answer holding it can only have come from memory.

## What not to do

- Don't search with no scope. It looks across everyone.
- Don't take the user ID from the request body. Whoever sends the request could read someone else's memories.
- Don't save every message as written with `infer: false`. It fills a space's quota with chatter. Let a model distill, or save only chosen facts through a tool.
- Don't re-save what was recalled. The adapters only save the new exchange.
- Don't run a model call and a chain wait in a request path. `wait: "chain"` takes half a minute.
