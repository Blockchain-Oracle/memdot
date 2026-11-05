import { randomUUID } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import { jobs, memories, memoryInbox } from "@memdot/db";
import { enqueueMemory, JOB_KIND } from "@memdot/jobs";
import { messageText, parseFilter, RECALL_PREAMBLE } from "@memdot/memory-engine";
import { ChatMessageSchema } from "@memdot/memory-engine/llm";
import { openBody, sealWrite, searchMemories } from "@memdot/memory-server";
import { generateText, type ModelMessage, streamText } from "ai";
import { inArray } from "drizzle-orm";
import { streamSSE } from "hono/streaming";
import { db } from "../db.js";
import { HttpError } from "../lib/errors.js";
import { decayOf, resolveAssisted, searchEmbedder, spendSharedModel } from "../lib/namespaces.js";
import { accountOf, requireScope } from "../lib/principal.js";
import { authenticated, createRouter, errorResponses, jsonContent } from "../lib/router.js";
import type { Services } from "../types.js";
import { ScopeId } from "./memory-schemas.js";

/** Recent turns that make up the recall query. */
const RECALL_TURNS = 6;
const RECALL_LIMIT = 10;
const RECALL_THRESHOLD = 0.3;

const ChatRequest = z
  .object({
    model: z.string().optional().openapi({
      description:
        "Ignored: the account's configured model answers. Accepted so OpenAI clients work unchanged.",
    }),
    messages: z.array(ChatMessageSchema).min(1),
    stream: z.boolean().default(false),
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z.number().int().positive().optional(),
    top_p: z.number().min(0).max(1).optional(),
    namespace_id: z.uuid().optional(),
    user_id: ScopeId.optional(),
    agent_id: ScopeId.optional(),
    run_id: ScopeId.optional(),
    top_k: z.number().int().min(1).max(50).default(RECALL_LIMIT),
    store: z.boolean().default(true).openapi({
      description: "Remember this exchange afterwards",
    }),
  })
  .openapi("ChatCompletionRequest");

export function chatRoutes(services: Services) {
  const keys = services.memoryKeys;

  return createRouter().openapi(
    createRoute({
      method: "post",
      path: "/v1/chat/completions",
      tags: ["Chat"],
      summary: "An OpenAI-compatible chat that remembers",
      description:
        "Point any OpenAI client at MemDot, add user_id (or agent_id or run_id), and each call recalls what's relevant and remembers the exchange afterwards. Assisted namespaces only.",
      security: authenticated,
      middleware: [requireScope("memories", "write")] as const,
      request: { body: { content: jsonContent(ChatRequest), required: true } },
      responses: {
        200: {
          description: "A chat completion, or a stream of chunks",
          content: {
            "application/json": { schema: z.record(z.string(), z.unknown()) },
            "text/event-stream": { schema: z.string() },
          },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      if (!body.user_id && !body.agent_id && !body.run_id) {
        throw new HttpError(
          409,
          "SCOPE_REQUIRED",
          "Give at least one of user_id, agent_id or run_id.",
        );
      }
      const namespace = await resolveAssisted(c, body.namespace_id);
      const models = await searchEmbedder(c, services);
      if (!models.llm) {
        throw new HttpError(409, "MODEL_REQUIRED", "Set a model under Configuration first.");
      }
      await spendSharedModel(c);
      const accountId = accountOf(c);
      const llm = models.llm;

      const scope = {
        ...(body.user_id ? { user_id: body.user_id } : {}),
        ...(body.agent_id ? { agent_id: body.agent_id } : {}),
        ...(body.run_id ? { run_id: body.run_id } : {}),
      };
      const query = body.messages
        .slice(-RECALL_TURNS)
        .map((message) => `${message.role}: ${messageText(message)}`)
        .join("\n");
      const hits = await searchMemories(db, keys, {
        folderId: namespace.id,
        query,
        limit: body.top_k,
        threshold: RECALL_THRESHOLD,
        mode: "hybrid",
        filter: parseFilter(scope),
        at: new Date(),
        showExpired: false,
        embedder: models.embedder,
        decayHalfLifeDays: await decayOf(namespace.id),
      });
      const rows = hits.length
        ? await db
            .select({ id: memories.id, sealedText: memories.sealedText })
            .from(memories)
            .where(
              inArray(
                memories.id,
                hits.map((hit) => hit.id),
              ),
            )
        : [];
      const recalled = rows.flatMap((row) =>
        row.sealedText ? [`- ${openBody(keys, namespace.id, row.sealedText).text}`] : [],
      );

      // The model takes system text apart from the conversation.
      const instructions = [
        ...body.messages.filter((m) => m.role === "system").map(messageText),
        ...(recalled.length ? [`${RECALL_PREAMBLE}\n\n${recalled.join("\n")}`] : []),
      ].join("\n\n");
      const messages = body.messages
        .filter((message) => message.role !== "system")
        .map((message) => ({ role: message.role, content: messageText(message) }) as ModelMessage);
      const settings = {
        ...(instructions ? { instructions } : {}),
        ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
        ...(body.max_tokens !== undefined ? { maxOutputTokens: body.max_tokens } : {}),
        ...(body.top_p !== undefined ? { topP: body.top_p } : {}),
      };

      const remember = async (reply: string) => {
        if (!body.store) return;
        const sealed = sealWrite(keys, namespace.id, {
          kind: "add",
          messages: [...body.messages, { role: "assistant", content: reply }],
          userId: body.user_id,
          agentId: body.agent_id,
          runId: body.run_id,
          infer: true,
          procedural: false,
          source: { kind: "conversation", label: "chat-completions" },
        });
        await db.transaction(async (tx) => {
          const [row] = await tx
            .insert(jobs)
            .values({ accountId, kind: JOB_KIND.memoryAdd, payload: { folderId: namespace.id } })
            .returning({ id: jobs.id });
          if (!row) return;
          await tx.insert(memoryInbox).values({ jobId: row.id, folderId: namespace.id, sealed });
          await enqueueMemory(services.boss, tx, { op: "add", jobId: row.id });
        });
      };

      const id = `chatcmpl-${randomUUID()}`;
      const created = Math.floor(Date.now() / 1000);
      const model = body.model ?? "memdot";

      if (!body.stream) {
        const result = await generateText({ model: llm, messages, ...settings });
        await remember(result.text);
        return c.json(
          {
            id,
            object: "chat.completion",
            created,
            model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: result.text },
                finish_reason: result.finishReason === "stop" ? "stop" : "length",
              },
            ],
            usage: {
              prompt_tokens: result.usage.inputTokens ?? 0,
              completion_tokens: result.usage.outputTokens ?? 0,
              total_tokens: result.usage.totalTokens ?? 0,
            },
            memdot: { recalled: recalled.length, namespace_id: namespace.id },
          },
          200,
        );
      }

      const chunk = (delta: Record<string, string>, finish: string | null) =>
        JSON.stringify({
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta, finish_reason: finish }],
        });
      return streamSSE(c, async (stream) => {
        const result = streamText({ model: llm, messages, ...settings });
        let reply = "";
        await stream.writeSSE({ data: chunk({ role: "assistant" }, null) });
        for await (const text of result.textStream) {
          reply += text;
          await stream.writeSSE({ data: chunk({ content: text }, null) });
        }
        await stream.writeSSE({ data: chunk({}, "stop") });
        await stream.writeSSE({ data: "[DONE]" });
        await remember(reply);
      }) as never;
    },
  );
}
