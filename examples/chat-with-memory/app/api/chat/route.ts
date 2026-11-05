import { google } from "@ai-sdk/google";
import { recallContext, withRecall } from "@memdot/sdk";
import { convertToModelMessages, streamText } from "ai";
import { after } from "next/server";
import { currentUser, MODEL, memdot } from "@/lib/server";
import type { ChatMessage } from "@/lib/types";

const SYSTEM = "You're a helpful assistant. Keep answers short.";

const textOf = (message: ChatMessage | undefined) =>
  message?.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n") ?? "";

export async function POST(request: Request) {
  const { messages } = (await request.json()) as { messages: ChatMessage[] };
  const userId = await currentUser();

  // Search here rather than inside the model call, so the page can show what the answer drew on.
  const memory = memdot.memory({ userId });
  const asked = textOf(messages.findLast((message) => message.role === "user"));
  const recalled = await memory.search(asked).catch((error) => {
    console.warn("Memory search skipped:", error.message);
    return [];
  });

  const result = streamText({
    // Saving what this exchange taught happens after the reply, without holding it up.
    model: memdot.wrap(google(MODEL), { userId, recall: false, waitUntil: after }),
    system: withRecall(SYSTEM, recallContext(recalled)),
    messages: await convertToModelMessages(messages),
  });

  return result.toUIMessageStreamResponse<ChatMessage>({
    messageMetadata: ({ part }) =>
      part.type === "start"
        ? { recalled: recalled.map(({ id, memory: text, score }) => ({ id, memory: text, score })) }
        : undefined,
  });
}
