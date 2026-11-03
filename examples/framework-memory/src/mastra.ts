import { Agent } from "@mastra/core/agent";
import { MemDotMemory, memdotTools } from "@memdot/mastra";
import { MODEL, newUser, report, secretWord, waitUntilFound } from "./shared.js";

const userId = newUser();
const word = secretWord();

// The same processor in both lists: recall going in, save coming out.
const memory = new MemDotMemory({ userId });
const agent = new Agent({
  id: "locker-keeper",
  name: "Locker keeper",
  instructions: "You help people with their lockers. Answer in one short sentence.",
  model: `google/${MODEL}`,
  inputProcessors: [memory],
  outputProcessors: [memory],
});

console.log(`First session, as ${userId}…`);
const first = await agent.generate(
  `Please remember this for later: my locker code word is ${word}.`,
);
console.log(first.text);

const { search_memory: search } = memdotTools({ userId });
await waitUntilFound(async () => {
  const found = await search.execute?.({ query: "locker code word" }, {} as never);
  return (found as { results: { memory: string }[] }).results;
}, word);

console.log("\nA new session, with nothing carried over but memory…");
const second = await agent.generate("What's my locker code word?");
report(word, second.text);

process.exit(0);
