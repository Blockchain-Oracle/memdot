import { generateText, jsonSchema, type LanguageModel, type ModelMessage, Output } from "ai";
import { z } from "zod";
import type { ChatMessage, ContentPart as MessagePart } from "./messages.js";
import {
  AGENT_SCOPE_SUFFIX,
  DEFAULT_CATEGORIES,
  DREAM_SYSTEM,
  EXTRACTION_SYSTEM,
  INSTRUCTIONS_SYSTEM,
  PROCEDURAL_SYSTEM,
  PROFILE_SYSTEM,
  type PromptCategory,
  RERANK_SYSTEM,
  STRUCTURED_EXPORT_SYSTEM,
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

/** No model call waits longer than this; a stalled provider must not hold a worker. */
const MODEL_TIMEOUT_MS = 120_000;
const timeout = () => AbortSignal.timeout(MODEL_TIMEOUT_MS);

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
  relations: z.array(z.object({ source: z.string(), relation: z.string(), target: z.string() })),
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
    abortSignal: timeout(),
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
    abortSignal: timeout(),
    instructions: prompt || PROCEDURAL_SYSTEM,
    messages: [{ role: "user", content: await conversationParts(messages, fetchDocument) }],
  });
  if (!text.trim()) throw new Error("The model returned an empty record.");
  return text.trim();
}

export async function summarizeMemories(model: LanguageModel, texts: string[]): Promise<string> {
  const { text } = await generateText({
    model,
    abortSignal: timeout(),
    instructions: SUMMARY_SYSTEM,
    prompt: texts.map((memory) => `- ${memory}`).join("\n"),
  });
  return text.trim();
}

const Profile = z.object({
  summary: z.string(),
  facts: z.array(z.object({ label: z.string(), value: z.string() })),
});
export type UserProfile = z.infer<typeof Profile>;

/** One person, from what's stored about them. Newest facts first, so conflicts resolve to them. */
export async function generateProfile(model: LanguageModel, texts: string[]): Promise<UserProfile> {
  const { output } = await generateText({
    model,
    abortSignal: timeout(),
    instructions: PROFILE_SYSTEM,
    output: Output.object({ schema: Profile }),
    prompt: texts.map((memory) => `- ${memory}`).join("\n"),
  });
  return output;
}

export const DreamKind = z.enum(["supersede", "merge", "synthesis"]);
const DreamProposal = z.object({
  kind: DreamKind,
  sources: z.array(z.string()),
  /** supersede: the memory that stays. */
  kept: z.string().nullable(),
  /** merge and synthesis: the new memory. */
  text: z.string().nullable(),
  reason: z.string(),
});
export type DreamProposal = z.infer<typeof DreamProposal>;
const DreamOutput = z.object({ proposals: z.array(DreamProposal) });

export interface DreamMemory {
  id: string;
  text: string;
  createdAt: string;
  userId?: string | null | undefined;
  agentId?: string | null | undefined;
  runId?: string | null | undefined;
}

const scopeLabel = ({ userId, agentId, runId }: DreamMemory) =>
  [
    userId ? `user ${userId}` : null,
    agentId ? `agent ${agentId}` : null,
    runId ? `run ${runId}` : null,
  ]
    .filter(Boolean)
    .join(", ");

/**
 * What a person may be shown. A proposal that names an id it wasn't given, reuses one, doesn't make
 * sense for its kind, or crosses from one person's memories to another's is dropped rather than
 * trusted: merging across people would quietly move what's known about one onto the other.
 */
export function usableProposals(proposals: DreamProposal[], memories: DreamMemory[]) {
  const scopes = new Map(memories.map((memory) => [memory.id, scopeLabel(memory)]));
  const used = new Set<string>();
  return proposals.filter((proposal) => {
    const named = [...proposal.sources, ...(proposal.kept ? [proposal.kept] : [])];
    const fits =
      named.every((id) => scopes.has(id) && !used.has(id)) &&
      new Set(named).size === named.length &&
      new Set(named.map((id) => scopes.get(id))).size === 1 &&
      proposal.sources.length > 0 &&
      (proposal.kind === "supersede"
        ? Boolean(proposal.kept)
        : Boolean(proposal.text?.trim()) && proposal.sources.length > 1);
    if (fits) for (const id of named) used.add(id);
    return fits;
  });
}

/** Changes a model suggests to a list of memories. It only reads and proposes: nothing here writes. */
export async function proposeDream(
  model: LanguageModel,
  memories: DreamMemory[],
): Promise<DreamProposal[]> {
  const { output } = await generateText({
    model,
    abortSignal: timeout(),
    instructions: DREAM_SYSTEM,
    output: Output.object({ schema: DreamOutput }),
    prompt: memories
      .map((memory) => {
        const scope = scopeLabel(memory);
        return `[${memory.id}] ${memory.createdAt}${scope ? ` (${scope})` : ""}: ${memory.text}`;
      })
      .join("\n"),
  });
  return usableProposals(output.proposals, memories);
}

/** Fills a schema the owner wrote from a list of memories. */
export async function exportToSchema(
  model: LanguageModel,
  texts: string[],
  schema: Record<string, unknown>,
  instructions?: string | null,
): Promise<unknown> {
  const { output } = await generateText({
    model,
    abortSignal: timeout(),
    instructions: STRUCTURED_EXPORT_SYSTEM,
    output: Output.object({ schema: jsonSchema(schema) }),
    prompt: [
      ...(instructions ? [`Export instructions:\n${instructions}`] : []),
      "Memories:",
      ...texts.map((memory) => `- ${memory}`),
    ].join("\n\n"),
  });
  return output;
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
    abortSignal: timeout(),
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
    abortSignal: timeout(),
    instructions: INSTRUCTIONS_SYSTEM,
    output: Output.object({ schema: GeneratedInstructions }),
    prompt: useCase,
  });
  return output;
}
