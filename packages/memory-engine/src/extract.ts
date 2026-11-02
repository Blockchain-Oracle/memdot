import { generateText, type LanguageModel, type ModelMessage, Output } from "ai";
import { z } from "zod";
import type { ChatMessage, ContentPart as MessagePart } from "./messages.js";
import {
  AGENT_SCOPE_SUFFIX,
  DEFAULT_CATEGORIES,
  EXTRACTION_SYSTEM,
  INSTRUCTIONS_SYSTEM,
  PROCEDURAL_SYSTEM,
  type PromptCategory,
  RERANK_SYSTEM,
  SUMMARY_SYSTEM,
} from "./prompts.js";

/** One part of a message: text, or a picture or document for the model to read. */
export const ContentPart = z.union([
  z.object({ type: z.literal("text"), text: z.string() }),
  z.object({ type: z.literal("image_url"), image_url: z.object({ url: z.string() }) }),
  z.object({ type: z.literal("pdf_url"), pdf_url: z.object({ url: z.string() }) }),
  z.object({ type: z.literal("txt_url"), txt_url: z.object({ url: z.string() }) }),
  z.object({ type: z.literal("mdx_url"), mdx_url: z.object({ url: z.string() }) }),
]);

export const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.union([z.string(), z.array(ContentPart)]),
  name: z.string().optional(),
});

/** Fetches a document a message names by URL; the server's version refuses private addresses. */
export type FetchDocument = (url: string) => Promise<{ bytes: Uint8Array; mime: string }>;

type UserContent = Exclude<Extract<ModelMessage, { role: "user" }>["content"], string>;

const DATA_URL = /^data:([^;,]+)(;base64)?,(.*)$/s;

/** Bytes behind a URL: decoded in place for a data URL, fetched for anything else. */
async function documentBytes(
  url: string,
  fetchDocument: FetchDocument,
): Promise<{ bytes: Uint8Array; mime: string }> {
  const inline = url.match(DATA_URL);
  if (!inline) return fetchDocument(url);
  const body = inline[3] ?? "";
  return {
    mime: inline[1] ?? "application/octet-stream",
    bytes: inline[2]
      ? Uint8Array.from(atob(body), (char) => char.charCodeAt(0))
      : new TextEncoder().encode(decodeURIComponent(body)),
  };
}

async function attachment(part: MessagePart, fetchDocument: FetchDocument) {
  switch (part.type) {
    case "text":
      return [{ type: "text" as const, text: part.text }];
    case "image_url": {
      const { bytes, mime } = await documentBytes(part.image_url.url, fetchDocument);
      return [{ type: "file" as const, data: bytes, mediaType: mime || "image" }];
    }
    case "pdf_url": {
      const { bytes } = await documentBytes(part.pdf_url.url, fetchDocument);
      return [{ type: "file" as const, data: bytes, mediaType: "application/pdf" }];
    }
    case "txt_url":
    case "mdx_url": {
      const url = part.type === "txt_url" ? part.txt_url.url : part.mdx_url.url;
      const { bytes } = await documentBytes(url, fetchDocument);
      return [{ type: "text" as const, text: new TextDecoder().decode(bytes) }];
    }
  }
}

/** The conversation as one user turn: speakers labelled in the text, attachments alongside. */
async function conversationParts(
  messages: ChatMessage[],
  fetchDocument: FetchDocument,
): Promise<UserContent> {
  const parts: UserContent = [];
  for (const message of messages) {
    const speaker = message.name ? `${message.role} (${message.name})` : message.role;
    if (typeof message.content === "string") {
      parts.push({ type: "text", text: `${speaker}: ${message.content}` });
      continue;
    }
    parts.push({ type: "text", text: `${speaker}:` });
    for (const part of message.content) parts.push(...(await attachment(part, fetchDocument)));
  }
  return parts;
}

const ExtractedMemory = z.object({
  text: z.string(),
  attributed_to: z.enum(["user", "assistant"]),
  entities: z.array(z.string()),
  categories: z.array(z.string()),
});
export type ExtractedMemory = z.infer<typeof ExtractedMemory>;

const Extraction = z.object({ memories: z.array(ExtractedMemory) });

export interface ExtractInput {
  messages: ChatMessage[];
  /** Nearby memories already stored, so the same fact isn't written twice. */
  known: string[];
  instructions?: string | null | undefined;
  categories?: PromptCategory[] | null | undefined;
  /** What relative dates in the conversation count from. */
  observedAt: Date;
  /** Written from the agent's point of view: an agent's memory with no user in scope. */
  agentScoped: boolean;
  fetchDocument: FetchDocument;
}

const isoDate = (date: Date) => date.toISOString().slice(0, 10);

function categoryList(categories: PromptCategory[] | null | undefined): string {
  const list = categories?.length
    ? categories
    : DEFAULT_CATEGORIES.map((name): PromptCategory => ({ name }));
  return list
    .map(({ name, description }) => (description ? `${name}: ${description}` : name))
    .join("\n");
}

/** One model call: a conversation in, the facts worth keeping out. */
export async function extractMemories(
  model: LanguageModel,
  input: ExtractInput,
): Promise<ExtractedMemory[]> {
  const known = input.known.length
    ? input.known.map((text) => `- ${text}`).join("\n")
    : "(nothing yet)";
  const preface = [
    `Observation date: ${isoDate(input.observedAt)}`,
    `Categories:\n${categoryList(input.categories)}`,
    `Already known:\n${known}`,
    ...(input.instructions ? [`Custom instructions:\n${input.instructions}`] : []),
    "Conversation:",
  ].join("\n\n");
  const { output } = await generateText({
    model,
    instructions: EXTRACTION_SYSTEM + (input.agentScoped ? AGENT_SCOPE_SUFFIX : ""),
    output: Output.object({ schema: Extraction }),
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: preface },
          ...(await conversationParts(input.messages, input.fetchDocument)),
        ],
      },
    ],
  });
  return output.memories.filter((memory) => memory.text.trim().length > 0);
}

/** An agent's working record of a conversation, stored as one memory. */
export async function proceduralRecord(
  model: LanguageModel,
  messages: ChatMessage[],
  fetchDocument: FetchDocument,
  prompt?: string | null,
): Promise<string> {
  const { text } = await generateText({
    model,
    instructions: prompt || PROCEDURAL_SYSTEM,
    messages: [{ role: "user", content: await conversationParts(messages, fetchDocument) }],
  });
  if (!text.trim()) throw new Error("The model returned an empty record.");
  return text.trim();
}

export async function summarizeMemories(model: LanguageModel, texts: string[]): Promise<string> {
  const { text } = await generateText({
    model,
    instructions: SUMMARY_SYSTEM,
    prompt: texts.map((memory) => `- ${memory}`).join("\n"),
  });
  return text.trim();
}

const Relevance = z.object({ scores: z.array(z.number()) });

/** One relevance score per text, in order. A failure leaves ranking to the caller's fallback. */
export async function rerankTexts(
  model: LanguageModel,
  query: string,
  texts: string[],
): Promise<number[]> {
  const { output } = await generateText({
    model,
    instructions: RERANK_SYSTEM,
    output: Output.object({ schema: Relevance }),
    prompt: `Query: ${query}\n\n${texts.map((text, i) => `[${i}] ${text}`).join("\n")}\n\nGive exactly ${texts.length} scores, in order.`,
  });
  if (output.scores.length !== texts.length) throw new Error("Wrong number of scores.");
  return output.scores.map((score) => Math.min(1, Math.max(0, score)));
}

const GeneratedInstructions = z.object({
  custom_instructions: z.string(),
  test_message: z.string(),
});

export async function generateInstructions(model: LanguageModel, useCase: string) {
  const { output } = await generateText({
    model,
    instructions: INSTRUCTIONS_SYSTEM,
    output: Output.object({ schema: GeneratedInstructions }),
    prompt: useCase,
  });
  return output;
}
