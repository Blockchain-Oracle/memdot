// What all three examples do: tell an agent something in one session, then ask in a new one.

export const MODEL = process.env.EXAMPLE_MODEL ?? "gemini-3.5-flash";
const POLL_MS = 2_000;
const SAVE_WAIT_MS = 120_000;

/** A word no model could guess, so an answer holding it can only have come from memory. */
export const secretWord = () => `zebra-${Math.floor(1000 + Math.random() * 9000)}`;

/** Someone new each run, so one run can't answer from another's memories. */
export const newUser = () => `example-${Date.now().toString(36)}`;

/** Saving happens in the background, so wait until the next session could find it. */
export async function waitUntilFound(
  search: () => Promise<{ memory: string }[]>,
  word: string,
): Promise<void> {
  const deadline = Date.now() + SAVE_WAIT_MS;
  while (Date.now() < deadline) {
    const found = await search();
    if (found.some((hit) => hit.memory.includes(word))) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`"${word}" wasn't saved within ${SAVE_WAIT_MS / 1000} seconds.`);
}

export function report(word: string, answer: string): void {
  console.log(`\nAnswer: ${answer.trim()}\n`);
  if (!answer.includes(word)) {
    console.error(`The answer doesn't have ${word} in it, so it didn't come from memory.`);
    process.exit(1);
  }
  console.log(`It knew ${word}, which only the first session was told.`);
}
