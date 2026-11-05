import { ChatGoogleGenerativeAI } from "@langchain/google-genai";
import { MemDotStore, memdotMiddleware, memdotTools } from "@memdot/langchain";
import { createAgent } from "langchain";
import { MODEL, newUser, report, secretWord, waitUntilFound } from "./shared.js";

const userId = newUser();
const word = secretWord();
const llm = new ChatGoogleGenerativeAI({ model: MODEL });

// An agent recalls before the model runs and saves when it finishes.
const agent = createAgent({ model: llm, tools: [], middleware: [memdotMiddleware({ userId })] });

console.log(`First session, as ${userId}…`);
const first = await agent.invoke({
  messages: [
    { role: "user", content: `Please remember this for later: my bicycle is called ${word}.` },
  ],
});
console.log(first.messages.at(-1)?.text);

const [, recall] = memdotTools({ userId });
await waitUntilFound(async () => {
  const text = await recall.invoke({ query: "what is the bicycle called" });
  return [{ memory: String(text) }];
}, word);

console.log("\nA new session, with nothing carried over but memory…");
const second = await agent.invoke({
  messages: [{ role: "user", content: "What's my bicycle called?" }],
});
report(word, second.messages.at(-1)?.text ?? "");

// A LangGraph store: key-addressed, stored as written, found by meaning.
const namespaceId = process.env.MEMDOT_NAMESPACE;
const store = new MemDotStore(undefined, namespaceId ? { namespaceId } : {});
const shelf = ["examples", userId];
await store.put(shelf, "deploys", { text: `Deploy freezes start on ${word}` });
const item = await store.get(shelf, "deploys");
const found = await store.search(shelf, { query: "when do deploy freezes start?", limit: 3 });
report(word, `${item?.value.text} / ${found[0]?.value.text}`);
await store.delete(shelf, "deploys");

process.exit(0);
