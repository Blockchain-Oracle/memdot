# The same memory in three frameworks

Each script tells an agent something in one session, then asks in a new session with nothing carried over but memory. A word no model could guess proves where the answer came from.

| Script | Framework | What it uses |
|---|---|---|
| [`src/ai-sdk.ts`](src/ai-sdk.ts) | AI SDK 7 | `memdot.wrap(model, …)` while generating and streaming, then `memdot.tools(…)` |
| [`src/langchain.ts`](src/langchain.ts) | LangChain 1 | `memdotMiddleware`, `memdotTools` and `MemDotStore` for LangGraph |
| [`src/mastra.ts`](src/mastra.ts) | Mastra 1 | `MemDotMemory` in both processor lists, and `memdotTools` |

## Run it

You need Node 22.13 or newer and a free [Gemini key](https://aistudio.google.com/apikey). Any other model works by changing one line in each script.

From a clone of this repository:

```bash
pnpm install
pnpm --filter "@memdot/example-framework-memory..." build
```

Connect once with `memdot login`, or set `MEMDOT_API_KEY` to a key from the dashboard's API keys page. Then, with your model key:

```bash
export GOOGLE_GENERATIVE_AI_API_KEY=your-key GOOGLE_API_KEY=your-key
pnpm --filter @memdot/example-framework-memory ai-sdk
pnpm --filter @memdot/example-framework-memory langchain
pnpm --filter @memdot/example-framework-memory mastra
```

Each prints the answer and says whether it came from memory. Set `MEMDOT_NAMESPACE` to choose where memories go. In a Private namespace, recall and search run on your machine, which downloads a small model the first time, and the AI SDK script keeps messages as typed because that namespace has no model of its own.

Set `EXAMPLE_MODEL` to use a Gemini model other than `gemini-3.5-flash`.
