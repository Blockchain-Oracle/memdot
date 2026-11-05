import { createRoute, z } from "@hono/zod-openapi";
import { memories, memorySettings } from "@memdot/db";
import { type CopilotData, streamCopilot } from "@memdot/memory-engine/llm";
import { openBody, scopeOf, searchMemories } from "@memdot/memory-server";
import { convertToModelMessages, type UIMessage } from "ai";
import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db.js";
import { conflict } from "../lib/errors.js";
import {
  accountModels,
  resolveAssisted,
  searchEmbedder,
  spendSharedModel,
} from "../lib/namespaces.js";
import { newestFirst } from "../lib/pagination.js";
import { requireScope } from "../lib/principal.js";
import { authenticated, createRouter, errorResponses, jsonContent } from "../lib/router.js";
import type { Services } from "../types.js";

/** Below this, a match isn't worth the model's attention. */
const SEARCH_THRESHOLD = 0.2;

export function copilotRoutes(services: Services) {
  const keys = services.memoryKeys;

  return createRouter().openapi(
    createRoute({
      method: "post",
      path: "/v1/copilot",
      tags: ["Memories"],
      summary: "An assistant that reads your memories and proposes changes",
      description:
        "Streams an AI SDK UI message stream. Its tools only read or propose: nothing changes until you apply a proposal yourself, with the ordinary calls. Assisted namespaces only: for a Private one, the SDK runs this in your browser with your own model.",
      security: authenticated,
      middleware: [requireScope("memories", "read")] as const,
      request: {
        body: {
          content: jsonContent(
            z.object({
              namespace_id: z.uuid().optional(),
              messages: z.array(z.record(z.string(), z.unknown())).min(1),
            }),
          ),
          required: true,
        },
      },
      responses: {
        200: {
          description: "A stream of UI messages",
          content: { "text/event-stream": { schema: z.string() } },
        },
        ...errorResponses,
      },
    }),
    async (c) => {
      const body = c.req.valid("json");
      const namespace = await resolveAssisted(c, body.namespace_id);
      const models = await accountModels(c, services);
      if (!models.llm) {
        throw conflict("MODEL_REQUIRED", "Set a model under Configuration to use Copilot.");
      }
      await spendSharedModel(c);
      const embedder = (await searchEmbedder(c, services)).embedder;

      const open = (row: { sealedText: Uint8Array | null }) =>
        row.sealedText ? openBody(keys, namespace.id, row.sealedText).text : "";

      const data: CopilotData = {
        async search(query, limit) {
          const hits = await searchMemories(db, keys, {
            folderId: namespace.id,
            query,
            limit,
            threshold: SEARCH_THRESHOLD,
            mode: "hybrid",
            at: new Date(),
            showExpired: false,
            embedder,
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
          const texts = new Map(rows.map((row) => [row.id, open(row)]));
          return hits.map((hit) => ({
            id: hit.id,
            memory: texts.get(hit.id) ?? "",
            score: hit.score,
          }));
        },
        async list(limit) {
          const rows = await db
            .select({
              id: memories.id,
              sealedText: memories.sealedText,
              userId: memories.userId,
            })
            .from(memories)
            .where(scopeOf(keys, { folderId: namespace.id, at: new Date(), showExpired: false }))
            .orderBy(...newestFirst(memories.createdAt, memories.id))
            .limit(limit);
          return rows.map((row) => ({ id: row.id, memory: open(row), user_id: row.userId }));
        },
        async settings() {
          const [row] = await db
            .select()
            .from(memorySettings)
            .where(eq(memorySettings.folderId, namespace.id));
          return {
            mode: "assisted" as const,
            custom_instructions: row?.customInstructions ?? null,
            categories:
              (row?.categories as { name: string; description?: string }[] | null) ?? null,
            decay_half_life_days: row?.decayHalfLifeDays ?? null,
          };
        },
        categories() {
          return db
            .select({ name: sql<string>`unnest(${memories.categories})`, count: count() })
            .from(memories)
            .where(and(eq(memories.folderId, namespace.id), isNull(memories.deletedAt)))
            .groupBy(sql`1`)
            .orderBy(desc(count()));
        },
      };

      const result = streamCopilot(
        models.llm,
        await convertToModelMessages(body.messages as unknown as UIMessage[]),
        data,
        {
          // The first call was paid for above. A step past the allowance still finishes the answer.
          onStepFinish: (() => {
            let steps = 0;
            return () => {
              steps += 1;
              if (steps > 1) void spendSharedModel(c).catch(() => {});
            };
          })(),
        },
      );
      return result.toUIMessageStreamResponse() as never;
    },
  );
}
