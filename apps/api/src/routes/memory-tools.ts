import { createRoute, z } from "@hono/zod-openapi";
import { memories, memoryProfiles, PRIVATE_PROFILES_SUBJECT } from "@memdot/db";
import { exportToSchema, generateProfile, proposeDream } from "@memdot/memory-engine/llm";
import { openBody, scopeOf } from "@memdot/memory-server";
import { and, count, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db.js";
import { badRequest, conflict } from "../lib/errors.js";
import {
  accountModels,
  loadNamespace,
  parseFilters,
  resolveAssisted,
  spendSharedModel,
} from "../lib/namespaces.js";
import { newestFirst } from "../lib/pagination.js";
import { requireScope } from "../lib/principal.js";
import { authenticated, createRouter, errorResponses, jsonContent } from "../lib/router.js";
import { fromBase64, IdParam, toBase64 } from "../schemas.js";
import type { Services } from "../types.js";
import { ListRequest, ScopeId } from "./memory-schemas.js";

/** Memories a profile reads at most, newest first, so a conflict resolves to the latest. */
const PROFILE_MEMORIES = 200;
const EXPORT_MEMORIES = 500;
/** A run reads this many at most: enough to find what's worth tidying in one model call. */
const DREAM_MEMORIES = 100;
const MAX_SCHEMA_CHARS = 20_000;

const Profile = z.object({
  summary: z.string(),
  facts: z.array(z.object({ label: z.string(), value: z.string() })),
});

const ProfileResponse = z
  .object({
    user_id: z.string(),
    /** none: nothing generated yet. */
    status: z.enum(["ready", "none"]),
    profile: Profile.nullable(),
    memories_read: z.number().int(),
    generated_at: z.string().nullable(),
  })
  .openapi("UserProfile");

const DreamProposal = z
  .object({
    kind: z.enum(["supersede", "merge", "synthesis"]),
    sources: z.array(z.uuid()),
    kept: z.uuid().nullable(),
    text: z.string().nullable(),
    reason: z.string(),
  })
  .openapi("DreamProposal");

export function memoryToolRoutes(services: Services) {
  const keys = services.memoryKeys;

  const needModel = async (c: Parameters<typeof accountModels>[0], purpose: string) => {
    const models = await accountModels(c, services);
    if (!models.llm) {
      throw conflict("MODEL_REQUIRED", `Set a model under Configuration to use ${purpose}.`);
    }
    return models.llm;
  };

  /** What a filter finds, opened, newest first. */
  const readTexts = async (
    folderId: string,
    filters: Record<string, unknown> | undefined,
    limit: number,
  ) => {
    const rows = await db
      .select()
      .from(memories)
      .where(
        scopeOf(keys, {
          folderId,
          filter: parseFilters(filters),
          at: new Date(),
          showExpired: false,
        }),
      )
      .orderBy(...newestFirst(memories.createdAt, memories.id))
      .limit(limit);
    return rows.flatMap((row) =>
      row.sealedText
        ? [
            {
              id: row.id,
              text: openBody(keys, folderId, row.sealedText).text,
              createdAt: row.createdAt.toISOString(),
              version: row.version,
              userId: row.userId,
              agentId: row.agentId,
              runId: row.runId,
            },
          ]
        : [],
    );
  };

  return createRouter()
    .openapi(
      createRoute({
        method: "get",
        path: "/v1/namespaces/{id}/categories",
        tags: ["Namespaces"],
        summary: "How many memories are filed under each category",
        description:
          "Assisted namespaces. A Private one's categories are sealed, and the SDK counts them on your device.",
        security: authenticated,
        middleware: [requireScope("memories", "read")] as const,
        request: { params: IdParam },
        responses: {
          200: {
            description: "Categories, most used first",
            content: jsonContent(
              z.object({
                categories: z.array(z.object({ name: z.string(), count: z.number().int() })),
                uncategorized: z.number().int(),
              }),
            ),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        const namespace = await loadNamespace(c, c.req.valid("param").id);
        const live = and(eq(memories.folderId, namespace.id), isNull(memories.deletedAt));
        const [categories, none] = await Promise.all([
          db
            .select({ name: sql<string>`unnest(${memories.categories})`, count: count() })
            .from(memories)
            .where(live)
            .groupBy(sql`1`)
            .orderBy(desc(count())),
          db
            .select({ count: count() })
            .from(memories)
            .where(and(live, sql`coalesce(array_length(${memories.categories}, 1), 0) = 0`)),
        ]);
        return c.json({ categories, uncategorized: none[0]?.count ?? 0 }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/v1/profiles",
        tags: ["Profiles"],
        summary: "One person's generated profile",
        security: authenticated,
        middleware: [requireScope("memories", "read")] as const,
        request: {
          query: z.object({ user_id: ScopeId, namespace_id: z.uuid().optional() }),
        },
        responses: {
          200: { description: "Profile", content: jsonContent(ProfileResponse) },
          ...errorResponses,
        },
      }),
      async (c) => {
        const query = c.req.valid("query");
        const namespace = await resolveAssisted(c, query.namespace_id);
        const [row] = await db
          .select()
          .from(memoryProfiles)
          .where(
            and(
              eq(memoryProfiles.folderId, namespace.id),
              eq(memoryProfiles.subject, query.user_id),
            ),
          );
        return c.json(
          {
            user_id: query.user_id,
            status: row ? ("ready" as const) : ("none" as const),
            profile: row
              ? (JSON.parse(keys.openRowText(namespace.id, row.sealed)) as z.infer<typeof Profile>)
              : null,
            memories_read: row?.memoriesRead ?? 0,
            generated_at: row?.generatedAt.toISOString() ?? null,
          },
          200,
        );
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/v1/profiles",
        tags: ["Profiles"],
        summary: "Generate or refresh one person's profile",
        description:
          "One model call, reading their newest memories. It's kept sealed like a memory, and goes when the memories it read go. Assisted namespaces: for a Private one, the SDK does this on your device.",
        security: authenticated,
        middleware: [requireScope("memories", "write")] as const,
        request: {
          body: {
            content: jsonContent(z.object({ user_id: ScopeId, namespace_id: z.uuid().optional() })),
            required: true,
          },
        },
        responses: {
          200: { description: "Profile", content: jsonContent(ProfileResponse) },
          ...errorResponses,
        },
      }),
      async (c) => {
        const body = c.req.valid("json");
        const namespace = await resolveAssisted(c, body.namespace_id);
        const model = await needModel(c, "profiles");
        const read = await readTexts(
          namespace.id,
          { AND: [{ user_id: { eq: body.user_id } }] },
          PROFILE_MEMORIES,
        );
        if (read.length === 0) {
          throw conflict("NOTHING_TO_READ", "Nothing is remembered about this person yet.");
        }
        await spendSharedModel(c);
        const profile = await generateProfile(
          model,
          read.map((memory) => memory.text),
        );
        const generatedAt = new Date();
        const values = {
          sealed: keys.sealRowText(namespace.id, JSON.stringify(profile)),
          memoriesRead: read.length,
          generatedAt,
        };
        await db.transaction(async (tx) => {
          // A model takes a while, and something it read may have been forgotten or changed since.
          // Writing it now would bring that back. Holding these rows makes a forget wait for this
          // and then remove the profile too.
          const current = new Map(
            (
              await tx
                .select({ id: memories.id, version: memories.version })
                .from(memories)
                .where(
                  and(
                    inArray(
                      memories.id,
                      read.map((memory) => memory.id),
                    ),
                    isNull(memories.deletedAt),
                  ),
                )
                .for("share")
            ).map((row) => [row.id, row.version]),
          );
          if (read.some((memory) => current.get(memory.id) !== memory.version)) {
            throw conflict(
              "MEMORIES_CHANGED",
              "These memories changed while the profile was being written. Try again.",
            );
          }
          await tx
            .insert(memoryProfiles)
            .values({ folderId: namespace.id, subject: body.user_id, ...values })
            .onConflictDoUpdate({
              target: [memoryProfiles.folderId, memoryProfiles.subject],
              set: values,
            });
        });
        return c.json(
          {
            user_id: body.user_id,
            status: "ready" as const,
            profile,
            memories_read: read.length,
            generated_at: generatedAt.toISOString(),
          },
          200,
        );
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/v1/namespaces/{id}/private/profiles",
        tags: ["Namespaces"],
        summary: "A Private namespace's profiles, sealed",
        description: "One blob, opened on your device. The server can't see who has a profile.",
        security: authenticated,
        middleware: [requireScope("memories", "read")] as const,
        request: { params: IdParam },
        responses: {
          200: {
            description: "Sealed profiles",
            content: jsonContent(z.object({ sealed: z.string().nullable() })),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        const namespace = await loadNamespace(c, c.req.valid("param").id);
        const [row] = await db
          .select({ sealed: memoryProfiles.sealed })
          .from(memoryProfiles)
          .where(
            and(
              eq(memoryProfiles.folderId, namespace.id),
              eq(memoryProfiles.subject, PRIVATE_PROFILES_SUBJECT),
            ),
          );
        return c.json({ sealed: toBase64(row?.sealed ?? null) }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "put",
        path: "/v1/namespaces/{id}/private/profiles",
        tags: ["Namespaces"],
        summary: "Save a Private namespace's profiles, sealed on your device",
        security: authenticated,
        middleware: [requireScope("memories", "write")] as const,
        request: {
          params: IdParam,
          body: {
            content: jsonContent(z.object({ sealed: z.string().min(1).max(4_000_000) })),
            required: true,
          },
        },
        responses: {
          200: {
            description: "Saved",
            content: jsonContent(z.object({ saved: z.boolean() })),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        const namespace = await loadNamespace(c, c.req.valid("param").id);
        if (namespace.memoryMode !== "private") {
          throw badRequest("NOT_PRIVATE", "Only a Private namespace keeps its profiles sealed.");
        }
        const sealed = fromBase64(c.req.valid("json").sealed);
        await db
          .insert(memoryProfiles)
          .values({ folderId: namespace.id, subject: PRIVATE_PROFILES_SUBJECT, sealed })
          .onConflictDoUpdate({
            target: [memoryProfiles.folderId, memoryProfiles.subject],
            set: { sealed, generatedAt: new Date() },
          });
        return c.json({ saved: true }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/v1/memories/exports",
        tags: ["Memories"],
        summary: "Fill a JSON schema from memories",
        description:
          "One model call reads the memories a filter finds and fills your schema. For everything as it's stored, list the memories instead. Assisted namespaces: for a Private one, the SDK does this on your device.",
        security: authenticated,
        middleware: [requireScope("memories", "read")] as const,
        request: {
          body: {
            content: jsonContent(
              z.object({
                schema: z.record(z.string(), z.unknown()),
                namespace_id: z.uuid().optional(),
                filters: ListRequest.shape.filters,
                instructions: z.string().max(4_000).optional(),
              }),
            ),
            required: true,
          },
        },
        responses: {
          200: {
            description: "The filled schema",
            content: jsonContent(
              z.object({ result: z.unknown(), memories_read: z.number().int() }),
            ),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        const body = c.req.valid("json");
        if (JSON.stringify(body.schema).length > MAX_SCHEMA_CHARS) {
          throw badRequest("SCHEMA_TOO_LARGE", "That schema is too long.");
        }
        const namespace = await resolveAssisted(c, body.namespace_id);
        const model = await needModel(c, "schema exports");
        const read = await readTexts(namespace.id, body.filters, EXPORT_MEMORIES);
        if (read.length === 0) {
          throw conflict("NOTHING_TO_READ", "Nothing here to export.");
        }
        await spendSharedModel(c);
        const result = await exportToSchema(
          model,
          read.map((memory) => memory.text),
          body.schema,
          body.instructions,
        ).catch((error: Error) => {
          throw badRequest(
            "SCHEMA_REFUSED",
            `The model couldn't fill that schema: ${error.message}`,
          );
        });
        return c.json({ result, memories_read: read.length }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/v1/memories/dream",
        tags: ["Memories"],
        summary: "Suggest how to tidy memories",
        description:
          "One model call reads memories and proposes what to supersede, merge or draw together. It changes nothing: you apply what you agree with, using the ordinary update, delete and add calls. Assisted namespaces: for a Private one, the SDK does this on your device.",
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
            description: "Proposals",
            content: jsonContent(
              z.object({
                proposals: z.array(DreamProposal),
                memories: z.array(
                  z.object({ id: z.uuid(), memory: z.string(), created_at: z.string() }),
                ),
              }),
            ),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        const body = c.req.valid("json");
        const namespace = await resolveAssisted(c, body.namespace_id);
        const model = await needModel(c, "tidying");
        const read = await readTexts(namespace.id, body.filters, DREAM_MEMORIES);
        if (read.length < 2) return c.json({ proposals: [], memories: [] }, 200);
        await spendSharedModel(c);
        const proposals = await proposeDream(model, read);
        return c.json(
          {
            proposals,
            memories: read.map((memory) => ({
              id: memory.id,
              memory: memory.text,
              created_at: memory.createdAt,
            })),
          },
          200,
        );
      },
    );
}
