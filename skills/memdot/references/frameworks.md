# Framework adapters

Middleware and processors recall before the model answers, framing memories as notes rather than instructions, and save what an exchange taught. If MemDot fails or stalls, the model answers without it after 8 seconds at most (`timeoutMs`), and `onError` hears why. Tools and stores are called directly, so they report failures to whoever called them.

These adapters run from a clone of the repository until the packages are on npm: see [typescript.md](typescript.md).

## AI SDK 7: `@memdot/ai-sdk`

```ts
import { google } from "@ai-sdk/google";
import { createMemDot } from "@memdot/ai-sdk";
import { generateText, stepCountIs, streamText } from "ai";

const memdot = createMemDot(); // the environment, or `memdot login`

// Any model, with memory around it. It runs where your code runs, so Private works too.
const model = memdot.wrap(google("gemini-2.5-flash"), { userId: "alex" });
const { text } = await generateText({ model, prompt: "What do I deploy on?" });

// Or let the model decide when to look.
await generateText({ model: google("gemini-2.5-flash"), tools: memdot.tools({ userId: "alex" }), stopWhen: stepCountIs(4), prompt });

// Or MemDot's own configured model, with no model key here. Assisted only, and no tool calls.
await generateText({ model: memdot({ userId: "alex" }), prompt });
```

Options for `wrap`: `namespaceId`, `recall`, `topK`, `threshold`, `save`, `timeoutMs`, `whenNoModel`, `waitUntil` (for example Next's `after`, so a save doesn't hold up the reply) and `onError`. Create the wrapped model per request when the user changes per request. An agent ID alone is refused unless you pass `shared: true`.

## LangChain and LangGraph (TypeScript): `@memdot/langchain`

```ts
import { MemDotStore, memdotMiddleware, memdotTools } from "@memdot/langchain";
import { createAgent } from "langchain";

// Who it's for comes from the options, or per call: agent.invoke(input, { context: { userId } })
// A call that doesn't say skips memory and reports it, rather than mixing people's.
const agent = createAgent({ model, tools: [], middleware: [memdotMiddleware({ userId: "alex" })] });

// Tools: remember and recall.
createAgent({ model, tools: memdotTools({ userId: "alex" }) });

// A LangGraph store: key-addressed, stored as written, found by meaning.
const store = new MemDotStore(undefined, { userOf: (namespace) => namespace[1] });
await store.put(["memories", "alex"], "deploys", { text: "Alex deploys on Fridays" });
await store.search(["memories", "alex"], { query: "when does Alex deploy?" });
```

The store's items have the same shape as Python's `MemDotStore`, so the two read each other's. `userOf` says which label names the person, so `memdot delete -u alex` covers these too. Without it, nothing is assumed. A search with a `query` looks at the 100 closest items, since finding by meaning can't be paged.

## Mastra: `@memdot/mastra`

```ts
import { Agent } from "@mastra/core/agent";
import { MemDotMemory, memdotTools } from "@memdot/mastra";

const memory = new MemDotMemory({ userId: "alex" }); // or per call, from the request context
const agent = new Agent({ id, name, instructions, model, inputProcessors: [memory], outputProcessors: [memory] });
```

`memdotTools({ userId })` gives `search_memory` and `save_memory` for the agent's `tools`.

## Python

```python
from memdot import AsyncMemDot, MemDot
from memdot.integrations.langgraph import MemDotStore, memory_tools       # memdot[langgraph]
from memdot.integrations.crewai import memory_tools                       # memdot[crewai]
from memdot.integrations.strands import MemDotMemoryStore                 # memdot[strands]
from memdot.integrations.openai_agents import MemDotSession, memory_tools # memdot[openai-agents]

store = MemDotStore(MemDot.from_credentials())
graph = builder.compile(store=store)
```

## No framework

`AgentMemory` from `@memdot/sdk` is what the TypeScript adapters use. See [typescript.md](typescript.md).

## Automation

- **n8n:** [`integrations/n8n-nodes-memdot`](https://github.com/Blockchain-Oracle/memdot/tree/main/integrations/n8n-nodes-memdot). A MemDot node, usable as a tool, and MemDot Chat Memory for the AI Agent's memory slot. Assisted namespaces, plus files with an agent identity.
- **Zapier:** [`integrations/zapier-memdot`](https://github.com/Blockchain-Oracle/memdot/tree/main/integrations/zapier-memdot). A New Memory trigger, add, update, delete, search and get. Assisted only, and no files, since Zapier's servers would have to hold the key.
