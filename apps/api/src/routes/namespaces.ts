import { createRoute, z } from "@hono/zod-openapi";
import { jobs, memories, memoryInbox, memorySegments, memorySettings, objects } from "@memdot/db";
import { enqueueMemory, JOB_KIND } from "@memdot/jobs";
import { parseMemoryImport } from "@memdot/memory-engine";
import { compactIfDue, openBody, sealWrite, tombstoneObjects } from "@memdot/memory-server";
import { and, desc, eq, inArray, isNull, notInArray, type SQL, sql } from "drizzle-orm";
import type { Context } from "hono";
import { db } from "../db.js";
import { badRequest, conflict } from "../lib/errors.js";
import {
  assertAssisted,
  loadNamespace,
  resolveAssisted,
  spendSharedModel,
} from "../lib/namespaces.js";
import { accountOf, principalOf, requireScope } from "../lib/principal.js";
import { authenticated, createRouter, errorResponses, jsonContent } from "../lib/router.js";
import { fromBase64, IdParam, SealedText, toBase64 } from "../schemas.js";
import type { AppEnv, Services } from "../types.js";
import { AddAccepted, NamespaceRow, NamespaceSettings } from "./memory-schemas.js";

/** Memories one import may hold. A JSON body caps at 1 MiB anyway. */
const MAX_IMPORT_ITEMS = 5_000;
/** Memories an export returns at most; a bigger namespace exports through the SDK. */
const MAX_EXPORT_ITEMS = 20_000;
/** Segments one registry record lists. */
const MAX_RECORD_BATCH = 100;
/** Memories embedded in one model call. */
const IMPORT_ITEMS_PER_CALL = 96;

const PrivateState = z
  .object({
    segments: z.array(
      z.object({
        id: z.uuid(),
        cid: z.string(),
        key_epoch: z.number().int(),
        status: z.string(),
        entries: z.number().int(),
      }),
    ),
    live: z.array(
      z.object({ id: z.uuid(), segment_id: z.uuid().nullable(), version: z.number().int() }),
    ),
    snapshot: z.object({ id: z.uuid(), cid: z.string(), key_epoch: z.number().int() }).nullable(),
  })
  .openapi("PrivateNamespaceState");

/** A key limited to some spaces only touches objects in those spaces. */
const allowedSpaces = (c: Context<AppEnv>) => {
  const allowed = principalOf(c).apiKey?.spaceIds;
  return allowed ? inArray(objects.spaceId, allowed) : undefined;
};

export function namespaceRoutes(services: Services) {
  const keys = services.memoryKeys;

  return createRouter()
    .openapi(
      createRoute({
        method: "get",
        path: "/v1/namespaces/unrecorded-segments",
        tags: ["Namespaces"],
        summary: "Memory segments not yet in the public registry",
        description:
          "The registry takes the owner's signature, which only their device can make. It adds these together on its next unlock.",
        security: authenticated,
        middleware: [requireScope("memories", "read")] as const,
        responses: {
          200: {
            description: "Segments",
            content: jsonContent(
              z.object({
                results: z.array(
                  z.object({
                    id: z.uuid(),
                    space_id: z.uuid(),
                    cid: z.string(),
                    size: z.number().int(),
                  }),
                ),
              }),
            ),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        const rows = await db
          .select({
            id: objects.id,
            spaceId: objects.spaceId,
            cid: objects.cid,
            size: objects.sizeBytes,
          })
          .from(memorySegments)
          .innerJoin(objects, eq(objects.id, memorySegments.objectId))
          .where(
            and(
              eq(objects.accountId, accountOf(c)),
              isNull(memorySegments.recordedAt),
              eq(objects.status, "stored"),
              allowedSpaces(c),
            ),
          )
          .limit(MAX_RECORD_BATCH);
        return c.json(
          {
            results: rows.map((row) => ({
              id: row.id,
              space_id: row.spaceId as string,
              cid: row.cid ?? "",
              size: row.size,
            })),
          },
          200,
        );
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/v1/namespaces/recorded-segments",
        tags: ["Namespaces"],
        summary: "Mark segments as recorded in the registry",
        security: authenticated,
        middleware: [requireScope("memories", "write")] as const,
        request: {
          body: {
            content: jsonContent(z.object({ ids: z.array(z.uuid()).min(1).max(MAX_RECORD_BATCH) })),
            required: true,
          },
        },
        responses: {
          200: {
            description: "Marked",
            content: jsonContent(z.object({ recorded: z.number().int() })),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        const { ids } = c.req.valid("json");
        const owned = db
          .select({ id: objects.id })
          .from(objects)
          .where(
            and(inArray(objects.id, ids), eq(objects.accountId, accountOf(c)), allowedSpaces(c)),
          );
        const rows = await db
          .update(memorySegments)
          .set({ recordedAt: new Date() })
          .where(inArray(memorySegments.objectId, owned))
          .returning({ id: memorySegments.objectId });
        return c.json({ recorded: rows.length }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/v1/namespaces",
        tags: ["Namespaces"],
        summary: "Memory namespaces, with their counts",
        description:
          "A namespace is a folder in memory mode. Create one at POST /v1/spaces/{id}/folders.",
        security: authenticated,
        middleware: [requireScope("memories", "read")] as const,
        request: { query: z.object({ space_id: z.uuid().optional() }) },
        responses: {
          200: {
            description: "Namespaces",
            content: jsonContent(z.object({ results: z.array(NamespaceRow) })),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        const allowed = principalOf(c).apiKey?.spaceIds;
        const { space_id: spaceId } = c.req.valid("query");
        const accountId = accountOf(c);
        const result = await db.execute<{
          id: string;
          space_id: string;
          encrypted_name: Buffer;
          memory_mode: "private" | "assisted";
          key_epoch: number;
          created_at: Date;
          total: number;
          segments: number;
          last_write: Date | null;
        }>(sql`
          select f.id, f.space_id, f.encrypted_name, f.memory_mode, s.key_epoch, f.created_at,
                 (select count(*)::int from memories m where m.folder_id = f.id and m.deleted_at is null) as total,
                 (select count(*)::int from memory_segments ms join objects o on o.id = ms.object_id
                   where ms.folder_id = f.id and o.status not in ('tombstoned', 'failed')) as segments,
                 (select max(m.updated_at) from memories m where m.folder_id = f.id and m.deleted_at is null) as last_write
            from folders f
            join spaces s on s.id = f.space_id
           where s.account_id = ${accountId}
             and s.deleted_at is null
             and f.deleted_at is null
             and f.memory_mode <> 'off'
             ${spaceId ? sql`and f.space_id = ${spaceId}` : sql``}
             ${
               allowed
                 ? sql`and f.space_id = any(${sql`array[${sql.join(
                     allowed.map((id) => sql`${id}::uuid`),
                     sql`, `,
                   )}]`})`
                 : sql``
             }
           order by f.created_at`);
        return c.json(
          {
            results: result.rows.map((row) => ({
              id: row.id,
              space_id: row.space_id,
              encrypted_name: Buffer.from(row.encrypted_name).toString("base64"),
              mode: row.memory_mode,
              key_epoch: row.key_epoch,
              total_memories: row.total,
              segments: row.segments,
              last_write: row.last_write ? new Date(row.last_write).toISOString() : null,
              created_at: new Date(row.created_at).toISOString(),
            })),
          },
          200,
        );
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/v1/namespaces/{id}/settings",
        tags: ["Namespaces"],
        summary: "A namespace's custom instructions and categories",
        security: authenticated,
        middleware: [requireScope("memories", "read")] as const,
        request: { params: IdParam },
        responses: {
          200: { description: "Settings", content: jsonContent(NamespaceSettings) },
          ...errorResponses,
        },
      }),
      async (c) => {
        const namespace = await loadNamespace(c, c.req.valid("param").id);
        const [row] = await db
          .select()
          .from(memorySettings)
          .where(eq(memorySettings.folderId, namespace.id));
        return c.json(
          {
            custom_instructions: row?.customInstructions ?? null,
            categories:
              (row?.categories as { name: string; description?: string }[] | null) ?? null,
            sealed: toBase64(row?.sealed ?? null),
          },
          200,
        );
      },
    )
    .openapi(
      createRoute({
        method: "put",
        path: "/v1/namespaces/{id}/settings",
        tags: ["Namespaces"],
        summary: "Set a namespace's custom instructions and categories",
        description:
          "Assisted: the server reads these to extract. Private: send `sealed`, encrypted on your device, and the server only keeps it.",
        security: authenticated,
        middleware: [requireScope("memories", "write")] as const,
        request: {
          params: IdParam,
          body: {
            content: jsonContent(
              NamespaceSettings.partial().extend({ sealed: SealedText.nullable().optional() }),
            ),
            required: true,
          },
        },
        responses: {
          200: { description: "Settings", content: jsonContent(NamespaceSettings) },
          ...errorResponses,
        },
      }),
      async (c) => {
        const namespace = await loadNamespace(c, c.req.valid("param").id);
        const body = c.req.valid("json");
        if (namespace.memoryMode === "private" && (body.custom_instructions || body.categories)) {
          throw badRequest(
            "SEAL_SETTINGS",
            "A Private namespace's settings must stay on your device: seal them and send `sealed`.",
          );
        }
        const values = {
          customInstructions: body.custom_instructions ?? null,
          categories: body.categories ?? null,
          sealed: body.sealed ? fromBase64(body.sealed) : null,
          updatedAt: new Date(),
        };
        const [row] = await db
          .insert(memorySettings)
          .values({ folderId: namespace.id, ...values })
          .onConflictDoUpdate({ target: memorySettings.folderId, set: values })
          .returning();
        return c.json(
          {
            custom_instructions: row?.customInstructions ?? null,
            categories:
              (row?.categories as { name: string; description?: string }[] | null) ?? null,
            sealed: toBase64(row?.sealed ?? null),
          },
          200,
        );
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/v1/namespaces/{id}/reset",
        tags: ["Namespaces"],
        summary: "Forget everything in a namespace",
        description: "Stops renewing its segments, which then expire from the chain within 7 days.",
        security: authenticated,
        middleware: [requireScope("memories", "write")] as const,
        request: { params: IdParam },
        responses: {
          200: {
            description: "Reset",
            content: jsonContent(z.object({ message: z.string(), segments: z.number().int() })),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        const namespace = await loadNamespace(c, c.req.valid("param").id);
        const segments = await db.transaction((tx) =>
          tombstoneObjects(
            tx,
            and(
              eq(objects.folderId, namespace.id),
              inArray(objects.kind, ["segment", "index_snapshot"]),
            ) as SQL,
          ),
        );
        return c.json({ message: "The namespace is empty.", segments }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/v1/namespaces/{id}/restore",
        tags: ["Namespaces"],
        summary: "Rebuild the index from the chain",
        description:
          "Assisted: reads every segment back from V3 and derives the text, keyword terms and vectors again. A Private namespace restores on your device, through the SDK.",
        security: authenticated,
        middleware: [requireScope("memories", "write")] as const,
        request: { params: IdParam },
        responses: {
          202: { description: "Accepted", content: jsonContent(AddAccepted) },
          ...errorResponses,
        },
      }),
      async (c) => {
        const namespace = await loadNamespace(c, c.req.valid("param").id);
        assertAssisted(namespace);
        const job = await db.transaction(async (tx) => {
          const [row] = await tx
            .insert(jobs)
            .values({
              accountId: accountOf(c),
              kind: JOB_KIND.memoryRestore,
              payload: { folderId: namespace.id },
            })
            .returning();
          if (!row) throw new Error("job insert returned no row");
          await enqueueMemory(services.boss, tx, { op: "restore", jobId: row.id });
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
        path: "/v1/namespaces/{id}/compact",
        tags: ["Namespaces"],
        summary: "Merge segments now, if it's worth it",
        description:
          "This also runs by itself whenever a namespace has many segments or a mostly dead one.",
        security: authenticated,
        middleware: [requireScope("memories", "write")] as const,
        request: { params: IdParam },
        responses: {
          200: { description: "Checked", content: jsonContent(z.object({ message: z.string() })) },
          ...errorResponses,
        },
      }),
      async (c) => {
        const namespace = await loadNamespace(c, c.req.valid("param").id);
        assertAssisted(namespace);
        await compactIfDue(db, services.boss, { accountId: accountOf(c), folderId: namespace.id });
        return c.json({ message: "Compaction checked." }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/v1/namespaces/{id}/export",
        tags: ["Namespaces"],
        summary: "Export an Assisted namespace's memories as JSON",
        description:
          "Private namespaces export through the SDK, since only your device can read them.",
        security: authenticated,
        middleware: [requireScope("memories", "read")] as const,
        request: { params: IdParam },
        responses: {
          200: {
            description: "Memories",
            content: jsonContent(
              z.object({
                namespace_id: z.uuid(),
                exported_at: z.string(),
                memories: z.array(z.record(z.string(), z.unknown())),
              }),
            ),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        const namespace = await loadNamespace(c, c.req.valid("param").id);
        assertAssisted(namespace);
        const rows = await db
          .select()
          .from(memories)
          .where(and(eq(memories.folderId, namespace.id), isNull(memories.deletedAt)))
          .orderBy(desc(memories.createdAt))
          .limit(MAX_EXPORT_ITEMS);
        return c.json(
          {
            namespace_id: namespace.id,
            exported_at: new Date().toISOString(),
            memories: rows.map((row) => ({
              id: row.id,
              memory: row.sealedText ? openBody(keys, row.folderId, row.sealedText).text : "",
              user_id: row.userId,
              agent_id: row.agentId,
              run_id: row.runId,
              metadata: row.metadata,
              categories: row.categories,
              expiration_date: row.expiresAt?.toISOString() ?? null,
              created_at: row.createdAt.toISOString(),
              updated_at: row.updatedAt.toISOString(),
            })),
          },
          200,
        );
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/v1/memories/import",
        tags: ["Memories"],
        summary: "Import memories",
        description:
          "Stored as written, with no model involved. Accepts MemDot's own export, or a list or {results: […]} from another memory product, with the text under memory, text, content or data. The same fact in the same scope is dropped.",
        security: authenticated,
        middleware: [requireScope("memories", "write")] as const,
        request: {
          body: {
            content: jsonContent(
              z.object({
                namespace_id: z.uuid().optional(),
                data: z.unknown().openapi({ description: "The export file's JSON" }),
                source: z.string().max(64).default("import"),
                user_id: z.string().max(128).optional().openapi({
                  description: "For rows that name no user",
                }),
              }),
            ),
            required: true,
          },
        },
        responses: {
          202: {
            description: "Accepted",
            content: jsonContent(
              AddAccepted.extend({ accepted: z.number().int(), skipped: z.number().int() }),
            ),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        const body = c.req.valid("json");
        const namespace = await resolveAssisted(c, body.namespace_id);
        const { items, skipped } = parseMemoryImport(body.data);
        if (items.length === 0) {
          throw badRequest("NOTHING_TO_IMPORT", "That file has no memories with text in them.");
        }
        if (items.length > MAX_IMPORT_ITEMS) {
          throw badRequest("TOO_LARGE", `Import at most ${MAX_IMPORT_ITEMS} memories at a time.`);
        }
        const unscoped = items.filter((item) => !item.userId && !item.agentId && !item.runId);
        if (unscoped.length > 0 && !body.user_id) {
          throw conflict(
            "SCOPE_REQUIRED",
            `${unscoped.length} of these memories name no user, agent or run. Pass user_id to file them under one.`,
          );
        }
        const scoped = items.map((item) =>
          item.userId || item.agentId || item.runId
            ? item
            : { ...item, userId: body.user_id as string },
        );
        // Imports use no language model, but each batch of them is embedded.
        await spendSharedModel(c, Math.ceil(scoped.length / IMPORT_ITEMS_PER_CALL));
        const sealed = sealWrite(keys, namespace.id, {
          kind: "import",
          items: scoped,
          source: body.source,
        });
        const job = await db.transaction(async (tx) => {
          const [row] = await tx
            .insert(jobs)
            .values({
              accountId: accountOf(c),
              kind: JOB_KIND.memoryImport,
              payload: { folderId: namespace.id },
            })
            .returning();
          if (!row) throw new Error("job insert returned no row");
          await tx.insert(memoryInbox).values({ jobId: row.id, folderId: namespace.id, sealed });
          await enqueueMemory(services.boss, tx, { op: "import", jobId: row.id });
          return row;
        });
        return c.json(
          {
            event_id: job.id,
            status: "PENDING" as const,
            namespace_id: namespace.id,
            accepted: items.length,
            skipped,
          },
          202,
        );
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/v1/namespaces/{id}/private",
        tags: ["Namespaces"],
        summary: "What a Private namespace's device needs to load",
        description:
          "Its encrypted segments and which entries are still live. The server holds only these ids; the device opens the rest.",
        security: authenticated,
        middleware: [requireScope("memories", "read")] as const,
        request: { params: IdParam },
        responses: {
          200: { description: "State", content: jsonContent(PrivateState) },
          ...errorResponses,
        },
      }),
      async (c) => {
        const namespace = await loadNamespace(c, c.req.valid("param").id);
        const segments = await db
          .select({
            id: objects.id,
            cid: objects.cid,
            keyEpoch: objects.keyEpoch,
            status: objects.status,
            entries: memorySegments.entries,
          })
          .from(memorySegments)
          .innerJoin(objects, eq(objects.id, memorySegments.objectId))
          .where(
            and(
              eq(memorySegments.folderId, namespace.id),
              notInArray(objects.status, ["tombstoned", "failed"]),
            ),
          );
        const live = await db
          .select({ id: memories.id, segmentId: memories.segmentId, version: memories.version })
          .from(memories)
          .where(and(eq(memories.folderId, namespace.id), isNull(memories.deletedAt)));
        const [snapshot] = await db
          .select({ id: objects.id, cid: objects.cid, keyEpoch: objects.keyEpoch })
          .from(objects)
          .where(
            and(
              eq(objects.folderId, namespace.id),
              eq(objects.kind, "index_snapshot"),
              eq(objects.status, "stored"),
            ),
          )
          .orderBy(desc(objects.createdAt))
          .limit(1);
        return c.json(
          {
            segments: segments.map((segment) => ({
              id: segment.id,
              cid: segment.cid ?? "",
              key_epoch: segment.keyEpoch ?? 0,
              status: segment.status,
              entries: segment.entries,
            })),
            live: live.map((row) => ({
              id: row.id,
              segment_id: row.segmentId,
              version: row.version,
            })),
            snapshot: snapshot
              ? { id: snapshot.id, cid: snapshot.cid ?? "", key_epoch: snapshot.keyEpoch ?? 0 }
              : null,
          },
          200,
        );
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/v1/namespaces/{id}/private/entries",
        tags: ["Namespaces"],
        summary: "Record a segment a device wrote to a Private namespace",
        description:
          "Ids and versions only, plus the file a memory came from so deleting the file can delete it. An existing id moves to its new version.",
        security: authenticated,
        middleware: [requireScope("memories", "write")] as const,
        request: {
          params: IdParam,
          body: {
            content: jsonContent(
              z.object({
                segment_id: z.uuid(),
                entries: z
                  .array(
                    z.object({
                      id: z.uuid(),
                      version: z.number().int().min(1),
                      source_object_id: z.uuid().optional(),
                    }),
                  )
                  .min(1)
                  .max(5_000),
              }),
            ),
            required: true,
          },
        },
        responses: {
          201: {
            description: "Recorded",
            content: jsonContent(z.object({ recorded: z.number().int() })),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        const namespace = await loadNamespace(c, c.req.valid("param").id);
        if (namespace.memoryMode !== "private") {
          throw badRequest("NOT_PRIVATE", "This route is for Private namespaces.");
        }
        const body = c.req.valid("json");
        const accountId = accountOf(c);
        const [segment] = await db
          .select({ id: objects.id })
          .from(objects)
          .where(
            and(
              eq(objects.id, body.segment_id),
              eq(objects.accountId, accountId),
              eq(objects.folderId, namespace.id),
              eq(objects.kind, "segment"),
            ),
          );
        if (!segment) throw badRequest("SEGMENT", "That segment isn't in this namespace.");
        const recorded = await db.transaction(async (tx) => {
          await tx
            .insert(memorySegments)
            .values({ objectId: segment.id, folderId: namespace.id, entries: body.entries.length })
            .onConflictDoNothing();
          const rows = await tx
            .insert(memories)
            .values(
              body.entries.map((entry) => ({
                id: entry.id,
                accountId,
                spaceId: namespace.spaceId,
                folderId: namespace.id,
                mode: "private" as const,
                version: entry.version,
                segmentId: segment.id,
                sourceObjectId: entry.source_object_id ?? null,
              })),
            )
            .onConflictDoUpdate({
              target: memories.id,
              set: {
                version: sql`excluded.version`,
                segmentId: sql`excluded.segment_id`,
                updatedAt: new Date(),
              },
              // Only this namespace's own live rows move: a guessed id can't take over another's.
              setWhere: and(
                eq(memories.accountId, accountId),
                eq(memories.folderId, namespace.id),
                isNull(memories.deletedAt),
              ),
            })
            .returning({ id: memories.id });
          return rows.length;
        });
        return c.json({ recorded }, 201);
      },
    );
}
