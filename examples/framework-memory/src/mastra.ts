import { Agent } from "@mastra/core/agent";
import { MemDotMemory, memdotTools } from "@memdot/mastra";
import { MODEL, newUser, report, secretWord, waitUntilFound } from "./shared.js";

const userId = newUser();
const word = secretWord();

// The same processor in both lists: recall going in, save coming out.
const memory = new MemDotMemory({ userId });
const agent = new Agent({
  id: "bicycle-keeper",
  name: "Bicycle keeper",
  instructions: "You help people look after their bicycles. Answer in one short sentence.",
  model: `google/${MODEL}`,
  inputProcessors: [memory],
  outputProcessors: [memory],
});

console.log(`First session, as ${userId}…`);
const first = await agent.generate(`Please remember this for later: my bicycle is called ${word}.`);
console.log(first.text);

const { search_memory: search } = memdotTools({ userId });
await waitUntilFound(async () => {
  const found = await search.execute?.({ query: "what is the bicycle called" }, {} as never);
  return (found as { results: { memory: string }[] }).results;
}, word);

console.log("\nA new session, with nothing carried over but memory…");
const second = await agent.generate("What's my bicycle called?");
report(word, second.text);

process.exit(0);
