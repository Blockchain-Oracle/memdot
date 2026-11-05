# Chat with memory

A chat assistant on Next.js and the AI SDK, with a panel showing what it remembers about you. Start a new conversation and it still knows you. Each reply shows which memories it drew on, and you can forget any of them.

The memory part is in [`app/api/chat/route.ts`](app/api/chat/route.ts):

```ts
const memdot = createMemDot();
const memory = memdot.memory({ userId });
const recalled = await memory.search(asked);

const result = streamText({
  model: memdot.wrap(google(MODEL), { userId, recall: false, waitUntil: after }),
  system: withRecall(SYSTEM, recallContext(recalled)),
  messages: await convertToModelMessages(messages),
});
```

If you don't need to show what was recalled, it's shorter still. Without `recall: false`, `wrap` does the search for you:

```ts
const result = streamText({ model: memdot.wrap(google(MODEL), { userId }), messages });
```

## Run it

From a clone of this repository, with Node 22.12 or newer:

```bash
pnpm install
pnpm --filter "@memdot/example-chat-with-memory^..." build
cp examples/chat-with-memory/.env.example examples/chat-with-memory/.env.local
```

Fill in `.env.local`:

| Variable | Where it comes from |
|---|---|
| `MEMDOT_API_KEY` | **API keys** in the [dashboard](https://app.84.46.247.92.sslip.io) |
| `GOOGLE_GENERATIVE_AI_API_KEY` | A free [Gemini key](https://aistudio.google.com/apikey). Any AI SDK model works by changing one line |
| `MEMDOT_NAMESPACE` | Optional. An Assisted namespace, from `memdot namespace ls` |

```bash
pnpm --filter @memdot/example-chat-with-memory dev
```

Open <http://localhost:5183>. Tell it something about yourself, press **New conversation**, and ask. A fact appears in the panel a few seconds after the reply, once a model has picked it out. Open a different browser to be a different person.

## Limits of this example

- **The cookie stands in for a real sign-in.** Each browser gets a random user ID. Use your own session in a real app, and never take the user ID from the request body.
- **The shared model has a daily allowance.** Past it, memories are stored as written. An account's own model key removes the limit.
- **Assisted only, as written.** MemDot's server reads this text to distill and search. For a Private namespace, connect with `memdot login --print-env` and set `MEMDOT_AGENT_IDENTITY` too, so search runs on this server with a local model and only ciphertext reaches MemDot.
