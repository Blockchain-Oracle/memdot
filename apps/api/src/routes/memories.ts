import { createRoute, z } from "@hono/zod-openapi";
import { jobs, memories, memoryHistory, memoryInbox, objects } from "@memdot/db";
import { enqueueMemory, JOB_KIND } from "@memdot/jobs";
import { normalizeMessages } from "@memdot/memory-engine";
import { rerankTexts, summarizeMemories } from "@memdot/memory-engine/llm";
import {
  blindDedupeKey,
  blindEntities,
  compactIfDue,
  emptySegments,
  forgetRows,
  type MemoryRow,
  openBody,
  persistMemories,
  scopeOf,
  sealBody,
  sealWrite,
  searchMemories,
  segmentStates,
  tombstoneObjects,
  writeTerms,
} from "@memdot/memory-server";
import { and, asc, count, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { Context } from "hono";
import { db } from "../db.js";
import { conflict, isUniqueViolation, notFound } from "../lib/errors.js";
import {
  accountModels,
  assertAssisted,
  assertSharedBudget,
  loadMemory,
  loadNamespace,
  parseFilters,
  resolveAssisted,
} from "../lib/namespaces.js";
import { afterCursor, encodeCursor, newestFirst } from "../lib/pagination.js";
import { accountOf, principalOf, requireScope } from "../lib/principal.js";
import { authenticated, createRouter, errorResponses, jsonContent } from "../lib/router.js";
import { IdParam } from "../schemas.js";
import type { AppEnv, Services } from "../types.js";
import {
  AddAccepted,
  AddRequest,
  Entity,
  type EventStatus,
  HistoryEntry,
  ListRequest,
  Memory,
  MemoryEventRow,
  MemoryPage,
  ScopeId,
  ScoredMemory,
  SearchRequest,
  UpdateRequest,
} from "./memory-schemas.js";

const MAX_BATCH = 1000;
/** Memories a summary reads at most, newest first. */
const SUMMARY_MEMORIES = 200;
/** Results sent to the model for reordering. */
const RERANK_CANDIDATES = 50;
const MEMORY_JOB_KINDS = [
  JOB_KIND.memoryAdd,
  JOB_KIND.memoryUpdate,
  JOB_KIND.memoryImport,
  JOB_KIND.memoryRestore,
  JOB_KIND.memoryCompact,
];
const EVENT_TYPE: Record<string, string> = {
  [JOB_KIND.memoryAdd]: "ADD",
  [JOB_KIND.memoryUpdate]: "UPDATE",
  [JOB_KIND.memoryImport]: "IMPORT",
  [JOB_KIND.memoryRestore]: "RESTORE",
  [JOB_KIND.memoryCompact]: "COMPACT",
};

/** Dates in the two spellings callers use; a bare date means the end of that day, UTC. */
function expiryDate(value: string | null | undefined): Date | null | undefined {
  if (value === undefined || value === null) return value;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T23:59:59.999Z`) : new Date(value);
}

const whenOf = (value: number | string): Date =>
  typeof value === "number" ? new Date(value * 1000) : new Date(value);

const iso = (date: Date | null) => date?.toISOString() ?? null;

type Keys = Services["memoryKeys"];

async function serialize(keys: Keys, rows: MemoryRow[]) {
  const segments = await segmentStates(
    db,
    rows.flatMap((row) => (row.segmentId ? [row.segmentId] : [])),
  );
  return rows.map((row) => {
    const segment = row.segmentId ? segments.get(row.segmentId) : undefined;
    return {
      id: row.id,
      memory: row.sealedText ? openBody(keys, row.folderId, row.sealedText).text : "",
      namespace_id: row.folderId,
      user_id: row.userId,
      agent_id: row.agentId,
      run_id: row.runId,
      metadata: row.metadata as Record<string, unknown> | null,
      categories: row.categories,
      memory_type: row.memoryType,
      attributed_to: row.attributedTo,
      source: row.sourceKind
        ? {
            kind: row.sourceKind as "conversation" | "file" | "manual" | "import",
            object_id: row.sourceObjectId,
            label: row.sourceLabel,
          }
        : null,
      raw: row.raw,
      immutable: row.immutable,
      version: row.version,
      feedback: row.feedback,
      expiration_date: iso(row.expiresAt),
      occurred_at: iso(row.occurredAt),
      created_at: row.createdAt.toISOString(),
      updated_at: row.updatedAt.toISOString(),
      segment: segment
        ? {
            id: row.segmentId as string,
            cid: segment.cid,
            status: segment.status,
            block: segment.block,
          }
        : null,
    };
  });
}

/** Keeps the response's order: rows come back from Postgres in any order. */
async function rowsById(ids: string[]): Promise<MemoryRow[]> {
  if (ids.length === 0) return [];
  const rows = await db.select().from(memories).where(inArray(memories.id, ids));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
}

const actorOf = (c: Context<AppEnv>) =>
  c.req.header("x-memdot-client")?.slice(0, 64) ??
  (principalOf(c).via === "session" ? "dashboard" : (principalOf(c).apiKey?.start ?? null));

function eventStatus(row: typeof jobs.$inferSelect): z.infer<typeof EventStatus> {
  if (row.status === "finalized") return "SUCCEEDED";
  if (row.status === "failed") return "FAILED";
  return row.status === "queued" ? "PENDING" : "RUNNING";
}

async function serializeEvent(keys: Keys, row: typeof jobs.$inferSelect) {
  const result = (row.result ?? {}) as {
    memories?: { id: string; event: string }[];
    duplicates?: number;
    indexed?: boolean;
    note?: string;
  };
  const ids = (result.memories ?? []).map((memory) => memory.id);
  const opened = new Map(
    (await rowsById(ids)).map((memory) => [
      memory.id,
      memory.sealedText ? openBody(keys, memory.folderId, memory.sealedText).text : null,
    ]),
  );
  return {
    id: row.id,
    event_type: EVENT_TYPE[row.kind] ?? row.kind,
    status: eventStatus(row),
    results: (result.memories ?? []).map((memory) => ({
      id: memory.id,
      memory: opened.get(memory.id) ?? null,
      event: memory.event,
    })),
    duplicates: result.duplicates ?? 0,
    indexed: result.indexed ?? false,
    note: result.note ?? null,
    error: row.status === "failed" ? row.error : null,
    tx_hash: row.txHash,
    block: row.block,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/**
 * Applies an update to one row: new sealed text, new terms and vector when the text changed, and a
 * history event. The caller writes the new version to the chain.
 */
async function applyUpdate(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  keys: Keys,
  row: MemoryRow,
  change: {
    text?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
    expiresAt?: Date | null | undefined;
    vector?: number[] | null | undefined;
    modelId?: string | undefined;
  },
  actor: string | null,
) {
  if (row.immutable) throw conflict("IMMUTABLE", "This memory is immutable, so it can't change.");
  const before = row.sealedText ? openBody(keys, row.folderId, row.sealedText) : { text: "" };
  const text = change.text ?? before.text;
  const textChanged = change.text !== undefined && change.text !== before.text;
  const scope = { userId: row.userId, agentId: row.agentId, runId: row.runId };
  const next = {
    version: row.version + 1,
    updatedAt: new Date(),
    metadata: change.metadata
      ? { ...((row.metadata as Record<string, unknown>) ?? {}), ...change.metadata }
      : row.metadata,
    ...(change.expiresAt !== undefined ? { expiresAt: change.expiresAt } : {}),
    ...(textChanged
      ? {
          // The old entity names described the old text.
          sealedText: sealBody(keys, row.folderId, { text }),
          entityTerms: blindEntities(keys, row.folderId, []),
          dedupeKey: blindDedupeKey(keys, row.folderId, text, scope),
          embedding: change.vector ?? null,
          embeddingModel: change.vector ? (change.modelId ?? null) : null,
          termCount: await writeTerms(tx, keys, row.id, row.folderId, text),
        }
      : {}),
  };
  await tx.update(memories).set(next).where(eq(memories.id, row.id));
  await tx.insert(memoryHistory).values({
    memoryId: row.id,
    event: "UPDATE",
    version: next.version,
    sealedText: keys.sealRowText(row.folderId, text),
    sealedPrevious: keys.sealRowText(row.folderId, before.text),
    actor,
  });
}

/** Forgets rows, then stops renewing any segment nothing live is left in. */
async function forget(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  where: SQL,
  actor: string | null,
): Promise<number> {
  const { ids, segmentIds } = await forgetRows(tx, where, actor);
  const empty = await emptySegments(tx, segmentIds);
  if (empty.length > 0) await tombstoneObjects(tx, inArray(objects.id, empty) as SQL);
  return ids.length;
}

export function memoryRoutes(services: Services) {
  const keys = services.memoryKeys;

  return createRouter()
    .openapi(
      createRoute({
        method: "post",
        path: "/v1/memories",
        tags: ["Memories"],
        summary: "Remember",
        description:
          "Assisted namespaces only: the server reads this text to extract memories, keeps it encrypted, and never stores it in the clear. Accepted at once; follow the event until it's indexed (searchable) and finalized (on chain). At least one of user_id, agent_id or run_id is required.",
        security: authenticated,
        middleware: [requireScope("memories", "write")] as const,
        request: { body: { content: jsonContent(AddRequest), required: true } },
        responses: {
          202: { description: "Accepted", content: jsonContent(AddAccepted) },
          ...errorResponses,
        },
      }),
      async (c) => {
        const body = c.req.valid("json");
        if (!body.user_id && !body.agent_id && !body.run_id) {
          throw conflictScope();
        }
        if (body.memory_type && !body.agent_id) {
          throw conflict("AGENT_REQUIRED", "A procedural memory needs agent_id.");
        }
        const namespace = await resolveAssisted(c, body.namespace_id);
        if (body.infer) await assertSharedBudget(c);
        const accountId = accountOf(c);
        const messages = normalizeMessages(body.messages as never);
        const expiresAt = expiryDate(body.expiration_date);
        const sealed = sealWrite(keys, namespace.id, {
          kind: "add",
          messages,
          userId: body.user_id,
          agentId: body.agent_id,
          runId: body.run_id,
          metadata: body.metadata,
          expiresAt: expiresAt?.toISOString(),
          occurredAt:
            body.timestamp !== undefined ? whenOf(body.timestamp).toISOString() : undefined,
          infer: body.infer,
          procedural: body.memory_type === "procedural_memory",
          prompt: body.prompt,
          categories: body.custom_categories?.flatMap((entry) =>
            Object.entries(entry).map(([name, description]) => ({ name, description })),
          ),
          immutable: body.immutable,
          source: body.source
            ? {
                kind: body.source.object_id ? "file" : "conversation",
                ...(body.source.object_id ? { objectId: body.source.object_id } : {}),
                ...(body.source.label ? { label: body.source.label } : {}),
              }
            : { kind: "conversation", ...(actorOf(c) ? { label: actorOf(c) as string } : {}) },
          actor: actorOf(c) ?? undefined,
        });
        const job = await db.transaction(async (tx) => {
          const [row] = await tx
            .insert(jobs)
            .values({
              accountId,
              kind: JOB_KIND.memoryAdd,
              payload: { folderId: namespace.id },
            })
            .returning();
          if (!row) throw new Error("job insert returned no row");
          await tx.insert(memoryInbox).values({ jobId: row.id, folderId: namespace.id, sealed });
          await enqueueMemory(services.boss, tx, { op: "add", jobId: row.id });
          return row;
        });
        return c.json(
          { event_id: job.id, status: "PENDING" as const, namespace_id: namespace.id },
          202,
        );
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/v1/memories/search",
        tags: ["Memories"],
        summary: "Recall",
        description:
          "Semantic similarity plus keyword matching and named entities. Keywords are ranked over blinded terms: the server keeps no readable index of your words.",
        security: authenticated,
        middleware: [requireScope("memories", "read")] as const,
        request: { body: { content: jsonContent(SearchRequest), required: true } },
        responses: {
          200: {
            description: "Results",
            content: jsonContent(z.object({ results: z.array(ScoredMemory) })),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        const body = c.req.valid("json");
        const namespace = await resolveAssisted(c, body.namespace_id);
        const models = await accountModels(c, services);
        const asOf = body.reference_date !== undefined ? whenOf(body.reference_date) : undefined;
        const ranked = await searchMemories(db, keys, {
          folderId: namespace.id,
          query: body.query,
          limit: body.rerank ? Math.max(body.top_k, RERANK_CANDIDATES) : body.top_k,
          threshold: body.threshold,
          mode: body.keyword_search ? "keyword" : body.mode,
          filter: parseFilters(body.filters),
          at: asOf ?? new Date(),
          asOf,
          showExpired: body.show_expired,
          embedder: models.embedder,
        });
        const rows = await rowsById(ranked.map((hit) => hit.id));
        const serialized = await serialize(keys, rows);
        const breakdown = new Map(ranked.map((hit) => [hit.id, hit]));
        let results: z.infer<typeof ScoredMemory>[] = serialized.map((memory) => {
          const hit = breakdown.get(memory.id);
          return {
            ...memory,
            score: hit?.score ?? 0,
            score_breakdown: {
              semantic: hit?.semantic ?? 0,
              bm25: hit?.bm25 ?? 0,
              entity: hit?.entity ?? 0,
            },
          };
        });
        if (body.rerank && models.llm && results.length > 1) {
          // A failed rerank leaves the order as it was: it only ever refines.
          try {
            const scores = await rerankTexts(
              models.llm,
              body.query,
              results.map((memory) => memory.memory),
            );
            results = results
              .map((memory, i) => ({ ...memory, rerank_score: scores[i] as number }))
              .sort((a, b) => (b.rerank_score as number) - (a.rerank_score as number));
          } catch (error) {
            console.warn("[memories] rerank skipped:", error);
          }
        }
        return c.json({ results: results.slice(0, body.top_k) }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/v1/memories/list",
        tags: ["Memories"],
        summary: "List with filters",
        security: authenticated,
        middleware: [requireScope("memories", "read")] as const,
        request: { body: { content: jsonContent(ListRequest), required: true } },
        responses: {
          200: { description: "A page", content: jsonContent(MemoryPage) },
          ...errorResponses,
        },
      }),
      async (c) => {
        const body = c.req.valid("json");
        const namespace = await resolveAssisted(c, body.namespace_id);
        const scope = scopeOf(keys, {
          folderId: namespace.id,
          filter: parseFilters(body.filters),
          at: new Date(),
          showExpired: body.show_expired,
        });
        const [total] = await db.select({ n: count() }).from(memories).where(scope);
        const rows = await db
          .select()
          .from(memories)
          .where(and(scope, afterCursor(body.cursor, memories.createdAt, memories.id)))
          .orderBy(...newestFirst(memories.createdAt, memories.id))
          .limit(body.page_size + 1);
        const pageRows = rows.slice(0, body.page_size);
        const last = pageRows.at(-1);
        return c.json(
          {
            results: await serialize(keys, pageRows),
            count: total?.n ?? 0,
            next_cursor:
              rows.length > body.page_size && last ? encodeCursor(last.createdAt, last.id) : null,
          },
          200,
        );
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/v1/memories/summary",
        tags: ["Memories"],
        summary: "Summarize what's known",
        security: authenticated,
        middleware: [requireScope("memories", "read")] as const,
        request: {
          body: {
            content: jsonContent(
              z.object({ namespace_id: z.uuid().optional(), filters: ListRequest.shape.filters }),
            ),
            required: true,
          },
        },
        responses: {
          200: {
            description: "Summary",
            content: jsonContent(z.object({ summary: z.string(), count: z.number().int() })),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        const body = c.req.valid("json");
        const namespace = await resolveAssisted(c, body.namespace_id);
        const models = await accountModels(c, services);
        if (!models.llm) {
          throw conflict("MODEL_REQUIRED", "Set a model under Configuration to use summaries.");
        }
        const rows = await db
          .select()
          .from(memories)
          .where(
            scopeOf(keys, {
              folderId: namespace.id,
              filter: parseFilters(body.filters),
              at: new Date(),
              showExpired: false,
            }),
          )
          .orderBy(...newestFirst(memories.createdAt, memories.id))
          .limit(SUMMARY_MEMORIES);
        const texts = rows.flatMap((row) =>
          row.sealedText ? [openBody(keys, row.folderId, row.sealedText).text] : [],
        );
        const summary = texts.length ? await summarizeMemories(models.llm, texts) : "";
        return c.json({ summary, count: texts.length }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/v1/memories/events",
        tags: ["Memories"],
        summary: "Recent memory events",
        security: authenticated,
        middleware: [requireScope("memories", "read")] as const,
        request: {
          query: z.object({
            limit: z.coerce.number().int().min(1).max(100).default(20),
            cursor: z.string().optional(),
          }),
        },
        responses: {
          200: {
            description: "Events",
            content: jsonContent(
              z.object({ results: z.array(MemoryEventRow), next_cursor: z.string().nullable() }),
            ),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        const { limit, cursor } = c.req.valid("query");
        const rows = await db
          .select()
          .from(jobs)
          .where(
            and(
              eq(jobs.accountId, accountOf(c)),
              inArray(jobs.kind, MEMORY_JOB_KINDS),
              afterCursor(cursor, jobs.createdAt, jobs.id),
            ),
          )
          .orderBy(...newestFirst(jobs.createdAt, jobs.id))
          .limit(limit + 1);
        const pageRows = rows.slice(0, limit);
        const last = pageRows.at(-1);
        return c.json(
          {
            results: await Promise.all(pageRows.map((row) => serializeEvent(keys, row))),
            next_cursor: rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null,
          },
          200,
        );
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/v1/memories/events/{id}",
        tags: ["Memories"],
        summary: "One memory event",
        security: authenticated,
        middleware: [requireScope("memories", "read")] as const,
        request: { params: IdParam },
        responses: {
          200: { description: "Event", content: jsonContent(MemoryEventRow) },
          ...errorResponses,
        },
      }),
      async (c) => {
        const [row] = await db
          .select()
          .from(jobs)
          .where(
            and(
              eq(jobs.id, c.req.valid("param").id),
              eq(jobs.accountId, accountOf(c)),
              inArray(jobs.kind, MEMORY_JOB_KINDS),
            ),
          );
        if (!row) throw notFound("Event");
        return c.json(await serializeEvent(keys, row), 200);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/v1/memories/{id}",
        tags: ["Memories"],
        summary: "Get one memory",
        description:
          "Works even after its expiry date; expiry only hides it from lists and search.",
        security: authenticated,
        middleware: [requireScope("memories", "read")] as const,
        request: { params: IdParam },
        responses: {
          200: { description: "Memory", content: jsonContent(Memory) },
          ...errorResponses,
        },
      }),
      async (c) => {
        const row = await loadMemory(c, c.req.valid("param").id);
        if (row.deletedAt) throw notFound("Memory");
        assertAssisted(await loadNamespace(c, row.folderId));
        const [memory] = await serialize(keys, [row]);
        return c.json(memory as z.infer<typeof Memory>, 200);
      },
    )
    .openapi(
      createRoute({
        method: "put",
        path: "/v1/memories/{id}",
        tags: ["Memories"],
        summary: "Update a memory",
        description:
          "Writes a new version to the chain. Metadata is merged. null clears the expiry.",
        security: authenticated,
        middleware: [requireScope("memories", "write")] as const,
        request: {
          params: IdParam,
          body: { content: jsonContent(UpdateRequest), required: true },
        },
        responses: {
          200: { description: "Memory", content: jsonContent(Memory) },
          ...errorResponses,
        },
      }),
      async (c) => {
        const row = await loadMemory(c, c.req.valid("param").id);
        if (row.deletedAt) throw notFound("Memory");
        assertAssisted(await loadNamespace(c, row.folderId));
        const body = c.req.valid("json");
        const models = await accountModels(c, services);
        const vector =
          body.text && models.embedder
            ? (await models.embedder.embed([body.text], "document"))[0]
            : undefined;
        try {
          await db.transaction(async (tx) => {
            await applyUpdate(
              tx,
              keys,
              row,
              {
                text: body.text,
                metadata: body.metadata,
                expiresAt: expiryDate(body.expiration_date),
                vector,
                modelId: models.embedder?.modelId,
              },
              actorOf(c),
            );
            await queueUpdateWrite(tx, services, row.accountId, row.folderId, [row.id]);
          });
        } catch (error) {
          if (isUniqueViolation(error, "memories_dedupe_idx")) {
            throw conflict("DUPLICATE_MEMORY", "Another memory in this scope already says that.");
          }
          throw error;
        }
        await compactIfDue(db, services.boss, row);
        const [memory] = await serialize(keys, await rowsById([row.id]));
        return c.json(memory as z.infer<typeof Memory>, 200);
      },
    )
    .openapi(
      createRoute({
        method: "delete",
        path: "/v1/memories/{id}",
        tags: ["Memories"],
        summary: "Forget a memory",
        description:
          "Gone from search and lists at once. Its encrypted entry leaves the chain when its segment is rewritten or expires; anything already read can't be recalled.",
        security: authenticated,
        middleware: [requireScope("memories", "write")] as const,
        request: { params: IdParam },
        responses: {
          200: {
            description: "Forgotten",
            content: jsonContent(z.object({ message: z.string() })),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        const row = await loadMemory(c, c.req.valid("param").id);
        await db.transaction((tx) => forget(tx, eq(memories.id, row.id) as SQL, actorOf(c)));
        await compactIfDue(db, services.boss, row);
        return c.json({ message: "Memory forgotten." }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "delete",
        path: "/v1/memories",
        tags: ["Memories"],
        summary: "Forget everything in a scope",
        description:
          'Needs at least one of user_id, agent_id or run_id. Use "*" for every value of one, or the namespace\'s reset to clear it all.',
        security: authenticated,
        middleware: [requireScope("memories", "write")] as const,
        request: {
          query: z.object({
            namespace_id: z.uuid().optional(),
            user_id: ScopeId.optional(),
            agent_id: ScopeId.optional(),
            run_id: ScopeId.optional(),
          }),
        },
        responses: {
          200: {
            description: "Forgotten",
            content: jsonContent(z.object({ message: z.string(), deleted: z.number().int() })),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        const query = c.req.valid("query");
        if (!query.user_id && !query.agent_id && !query.run_id) throw conflictScope();
        const namespace = await resolveAssisted(c, query.namespace_id);
        const match = (column: PgColumn, value: string | undefined) =>
          value === undefined
            ? undefined
            : value === "*"
              ? sql`${column} is not null`
              : eq(column, value);
        const where = and(
          eq(memories.folderId, namespace.id),
          match(memories.userId, query.user_id),
          match(memories.agentId, query.agent_id),
          match(memories.runId, query.run_id),
        ) as SQL;
        const deleted = await db.transaction((tx) => forget(tx, where, actorOf(c)));
        await compactIfDue(db, services.boss, { accountId: accountOf(c), folderId: namespace.id });
        return c.json({ message: `Forgot ${deleted} memories.`, deleted }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/v1/memories/{id}/history",
        tags: ["Memories"],
        summary: "What changed, and when",
        description: "A forgotten memory keeps its events, without the text.",
        security: authenticated,
        middleware: [requireScope("memories", "read")] as const,
        request: { params: IdParam },
        responses: {
          200: {
            description: "History, oldest first",
            content: jsonContent(z.object({ results: z.array(HistoryEntry) })),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        const row = await loadMemory(c, c.req.valid("param").id);
        assertAssisted(await loadNamespace(c, row.folderId));
        const events = await db
          .select()
          .from(memoryHistory)
          .where(eq(memoryHistory.memoryId, row.id))
          .orderBy(asc(memoryHistory.id));
        return c.json(
          {
            results: events.map((event) => ({
              id: event.id,
              memory_id: event.memoryId,
              old_memory: event.sealedPrevious
                ? keys.openRowText(row.folderId, event.sealedPrevious)
                : null,
              new_memory: event.sealedText
                ? keys.openRowText(row.folderId, event.sealedText)
                : null,
              event: event.event,
              actor: event.actor,
              version: event.version,
              created_at: event.createdAt.toISOString(),
            })),
          },
          200,
        );
      },
    )
    .openapi(
      createRoute({
        method: "put",
        path: "/v1/batch",
        tags: ["Memories"],
        summary: "Update many memories",
        description: "All in one transaction and one stored segment per namespace.",
        security: authenticated,
        middleware: [requireScope("memories", "write")] as const,
        request: {
          body: {
            content: jsonContent(
              z.object({
                memories: z
                  .array(
                    z.object({
                      memory_id: z.uuid(),
                      text: z.string().trim().min(1).max(64_000).optional(),
                      metadata: z.record(z.string(), z.unknown()).optional(),
                    }),
                  )
                  .min(1)
                  .max(MAX_BATCH),
              }),
            ),
            required: true,
          },
        },
        responses: {
          200: { description: "Updated", content: jsonContent(z.object({ message: z.string() })) },
          ...errorResponses,
        },
      }),
      async (c) => {
        const body = c.req.valid("json");
        const rows = await Promise.all(body.memories.map((item) => loadMemory(c, item.memory_id)));
        for (const row of rows) {
          if (row.deletedAt) throw notFound("Memory");
          assertAssisted(await loadNamespace(c, row.folderId));
        }
        const models = await accountModels(c, services);
        const texts = body.memories.flatMap((item) => (item.text ? [item.text] : []));
        const vectors = models.embedder ? await models.embedder.embed(texts, "document") : [];
        const vectorOf = new Map(texts.map((text, i) => [text, vectors[i]]));
        await db.transaction(async (tx) => {
          const byNamespace = new Map<string, string[]>();
          for (const [i, row] of rows.entries()) {
            const item = body.memories[i] as (typeof body.memories)[number];
            await applyUpdate(
              tx,
              keys,
              row,
              {
                text: item.text,
                metadata: item.metadata,
                vector: item.text ? vectorOf.get(item.text) : undefined,
                modelId: models.embedder?.modelId,
              },
              actorOf(c),
            );
            byNamespace.set(row.folderId, [...(byNamespace.get(row.folderId) ?? []), row.id]);
          }
          for (const [folderId, ids] of byNamespace) {
            await queueUpdateWrite(tx, services, accountOf(c), folderId, ids);
          }
        });
        return c.json({ message: `Updated ${rows.length} memories.` }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "delete",
        path: "/v1/batch",
        tags: ["Memories"],
        summary: "Forget many memories",
        security: authenticated,
        middleware: [requireScope("memories", "write")] as const,
        request: {
          body: {
            content: jsonContent(
              z.object({
                memories: z
                  .array(z.object({ memory_id: z.uuid() }))
                  .min(1)
                  .max(MAX_BATCH),
              }),
            ),
            required: true,
          },
        },
        responses: {
          200: {
            description: "Forgotten",
            content: jsonContent(z.object({ message: z.string() })),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        const ids = c.req.valid("json").memories.map((item) => item.memory_id);
        for (const id of ids) await loadMemory(c, id);
        const deleted = await db.transaction((tx) =>
          forget(tx, inArray(memories.id, ids) as SQL, actorOf(c)),
        );
        return c.json({ message: `Forgot ${deleted} memories.` }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/v1/feedback",
        tags: ["Memories"],
        summary: "Say whether a memory was any good",
        security: authenticated,
        middleware: [requireScope("memories", "write")] as const,
        request: {
          body: {
            content: jsonContent(
              z.object({
                memory_id: z.uuid(),
                feedback: z.enum(["POSITIVE", "NEGATIVE", "VERY_NEGATIVE"]).nullable(),
                feedback_reason: z.string().max(1_000).nullable().optional(),
              }),
            ),
            required: true,
          },
        },
        responses: {
          200: {
            description: "Recorded",
            content: jsonContent(
              z.object({
                id: z.uuid(),
                feedback: z.string().nullable(),
                feedback_reason: z.string().nullable(),
              }),
            ),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        const body = c.req.valid("json");
        const row = await loadMemory(c, body.memory_id);
        const reason = body.feedback ? (body.feedback_reason ?? null) : null;
        await db
          .update(memories)
          .set({ feedback: body.feedback, feedbackReason: reason })
          .where(eq(memories.id, row.id));
        return c.json({ id: row.id, feedback: body.feedback, feedback_reason: reason }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/v1/entities",
        tags: ["Entities"],
        summary: "The users, agents and runs a namespace remembers",
        security: authenticated,
        middleware: [requireScope("memories", "read")] as const,
        request: { query: z.object({ namespace_id: z.uuid().optional() }) },
        responses: {
          200: {
            description: "Entities",
            content: jsonContent(
              z.object({
                results: z.array(Entity),
                total_users: z.number().int(),
                total_agents: z.number().int(),
                total_runs: z.number().int(),
              }),
            ),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        const namespace = await resolveAssisted(c, c.req.valid("query").namespace_id);
        const result = await db.execute<{
          id: string;
          type: "user" | "agent" | "run";
          total: number;
          created: string;
          updated: string;
        }>(sql`
          with scoped as (
            select user_id, agent_id, run_id, created_at, updated_at from memories
             where folder_id = ${namespace.id} and deleted_at is null
          )
          select user_id as id, 'user' as type, count(*)::int as total,
                 min(created_at) as created, max(updated_at) as updated
            from scoped where user_id is not null group by user_id
          union all
          select agent_id, 'agent', count(*)::int, min(created_at), max(updated_at)
            from scoped where agent_id is not null group by agent_id
          union all
          select run_id, 'run', count(*)::int, min(created_at), max(updated_at)
            from scoped where run_id is not null group by run_id
          order by updated desc`);
        const of = (type: string) => result.rows.filter((row) => row.type === type).length;
        return c.json(
          {
            results: result.rows.map((row) => ({
              id: row.id,
              type: row.type,
              total_memories: row.total,
              created_at: new Date(row.created).toISOString(),
              updated_at: new Date(row.updated).toISOString(),
              namespace_id: namespace.id,
            })),
            total_users: of("user"),
            total_agents: of("agent"),
            total_runs: of("run"),
          },
          200,
        );
      },
    )
    .openapi(
      createRoute({
        method: "delete",
        path: "/v1/entities/{type}/{id}",
        tags: ["Entities"],
        summary: "Forget a user, agent or run, and every memory it holds",
        security: authenticated,
        middleware: [requireScope("memories", "write")] as const,
        request: {
          params: z.object({
            type: z.enum(["user", "agent", "run"]).openapi({ param: { name: "type", in: "path" } }),
            id: z
              .string()
              .min(1)
              .openapi({ param: { name: "id", in: "path" } }),
          }),
          query: z.object({ namespace_id: z.uuid().optional() }),
        },
        responses: {
          200: {
            description: "Forgotten",
            content: jsonContent(z.object({ message: z.string(), deleted: z.number().int() })),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        const { type, id } = c.req.valid("param");
        const namespace = await resolveAssisted(c, c.req.valid("query").namespace_id);
        const column = { user: memories.userId, agent: memories.agentId, run: memories.runId }[
          type
        ];
        const deleted = await db.transaction((tx) =>
          forget(tx, and(eq(memories.folderId, namespace.id), eq(column, id)) as SQL, actorOf(c)),
        );
        return c.json({ message: `Forgot ${deleted} memories.`, deleted }, 200);
      },
    );
}

const conflictScope = () =>
  conflict("SCOPE_REQUIRED", "Give at least one of user_id, agent_id or run_id.");

/** Writes updated memories to the chain as a new segment, followed by its own job. */
async function queueUpdateWrite(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  services: Services,
  accountId: string,
  folderId: string,
  memoryIds: string[],
) {
  const [job] = await tx
    .insert(jobs)
    .values({ accountId, kind: JOB_KIND.memoryUpdate, payload: { folderId } })
    .returning({ id: jobs.id });
  if (!job) throw new Error("job insert returned no row");
  await persistMemories(tx, services.boss, services.memoryKeys, {
    folderId,
    memoryIds,
    jobId: job.id,
  });
}
