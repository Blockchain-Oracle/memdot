import { google } from "@ai-sdk/google";
import { createMemDot } from "@memdot/ai-sdk";
import { generateText, stepCountIs, streamText } from "ai";
import { MODEL, newUser, report, secretWord, waitUntilFound } from "./shared.js";

const memdot = createMemDot();
const userId = newUser();
const word = secretWord();

// One line: any model, with memory around it.
const model = memdot.wrap(google(MODEL), { userId });

console.log(`First session, as ${userId}…`);
const first = await generateText({
  model,
  prompt: `Please remember this for later: my locker code word is ${word}.`,
});
console.log(first.text.trim());

const memory = memdot.memory({ userId });
await waitUntilFound(() => memory.search("locker code word"), word);

console.log("\nA new session, streaming, with nothing carried over but memory…");
const second = streamText({ model, prompt: "What's my locker code word?" });
let answer = "";
for await (const text of second.textStream) answer += text;
report(word, answer);

// Or let the model decide when to look, with the same memory as tools.
const tools = await generateText({
  model: google(MODEL),
  tools: memdot.tools({ userId }),
  stopWhen: stepCountIs(4),
  prompt: "Use your memory tools to find my locker code word, then tell me what it is.",
});
report(word, tools.text);

process.exit(0);
