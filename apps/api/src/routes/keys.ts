import { createRoute, z } from "@hono/zod-openapi";
import { MAX_SPACES_PER_ACCOUNT } from "@memdot/config";
import { agents, apikey } from "@memdot/db";
import { and, desc, eq, isNull } from "drizzle-orm";
import { auth } from "../auth/index.js";
import { API_KEY_ROLES, type ApiKeyMetadata, ROLE_PERMISSIONS } from "../auth/roles.js";
import { db } from "../db.js";
import { badRequest, notFound } from "../lib/errors.js";
import { loadSpace } from "../lib/ownership.js";
import {
  accountOf,
  assertFreshSession,
  forgetApiKeys,
  principalOf,
  requireAccountWide,
  requireScope,
} from "../lib/principal.js";
import { authenticated, createRouter, errorResponses, jsonContent } from "../lib/router.js";

const DAY_SECONDS = 24 * 60 * 60;
const MAX_EXPIRY_DAYS = 365;

const Role = z.enum(API_KEY_ROLES).openapi({
  description:
    "read_only: read files, memories and usage. read_write: also write. management: also manage spaces, keys, agents and grants.",
});

const ApiKey = z
  .object({
    id: z.string(),
    name: z.string().nullable(),
    start: z
      .string()
      .nullable()
      .openapi({ description: "The first characters, to recognise the key" }),
    role: Role,
    spaceIds: z.array(z.uuid()).nullable(),
    agentId: z.uuid().nullable(),
    lastUsedAt: z.iso.datetime().nullable(),
    expiresAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
  })
  .openapi("ApiKey");

const NewKey = ApiKey.extend({
  key: z.string().openapi({ description: "The full key. Shown once; store it now." }),
}).openapi("NewApiKey");

const CreateKey = z
  .object({
    name: z.string().trim().min(1).max(32),
    role: Role.default("read_write"),
    spaceIds: z.array(z.uuid()).min(1).max(MAX_SPACES_PER_ACCOUNT).nullable().default(null),
    agentId: z.uuid().optional(),
    expiresInDays: z.number().int().min(1).max(MAX_EXPIRY_DAYS).optional(),
  })
  .openapi("CreateApiKey");

type KeyRow = typeof apikey.$inferSelect;

function metadataOf(row: Pick<KeyRow, "metadata">): ApiKeyMetadata {
  const value = row.metadata ? (JSON.parse(row.metadata) as Partial<ApiKeyMetadata>) : {};
  return {
    role: API_KEY_ROLES.includes(value.role as never)
      ? (value.role as ApiKeyMetadata["role"])
      : "read_only",
    spaceIds: value.spaceIds ?? null,
    ...(value.agentId ? { agentId: value.agentId } : {}),
  };
}

const serialize = (row: KeyRow) => {
  const metadata = metadataOf(row);
  return {
    id: row.id,
    name: row.name,
    start: row.start,
    role: metadata.role,
    spaceIds: metadata.spaceIds,
    agentId: metadata.agentId ?? null,
    lastUsedAt: row.lastRequest?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
};

/** Mints a key through Better Auth on the server, so the role's permissions are server-set. */
async function mint(
  userId: string,
  input: { name: string; metadata: ApiKeyMetadata; expiresAt: Date | null },
) {
  const created = await auth.api.createApiKey({
    body: {
      userId,
      name: input.name,
      metadata: input.metadata,
      permissions: ROLE_PERMISSIONS[input.metadata.role],
      expiresIn: input.expiresAt
        ? Math.max(DAY_SECONDS, Math.round((input.expiresAt.getTime() - Date.now()) / 1000))
        : null,
    },
  });
  const [row] = await db.select().from(apikey).where(eq(apikey.id, created.id));
  if (!row) throw new Error("created key not found");
  return { ...serialize(row), key: created.key };
}

async function loadKey(userId: string, id: string) {
  const [row] = await db
    .select()
    .from(apikey)
    .where(and(eq(apikey.id, id), eq(apikey.referenceId, userId)))
    .limit(1);
  if (!row) throw notFound("API key");
  return row;
}

export function keyRoutes() {
  return createRouter()
    .openapi(
      createRoute({
        method: "get",
        path: "/v1/keys",
        tags: ["API keys"],
        summary: "List API keys",
        security: authenticated,
        middleware: [requireScope("keys", "read"), requireAccountWide] as const,
        responses: {
          200: { description: "Keys", content: jsonContent(z.object({ items: z.array(ApiKey) })) },
          ...errorResponses,
        },
      }),
      async (c) => {
        const rows = await db
          .select()
          .from(apikey)
          .where(eq(apikey.referenceId, principalOf(c).userId))
          .orderBy(desc(apikey.createdAt));
        return c.json({ items: rows.map(serialize) }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/v1/keys",
        tags: ["API keys"],
        summary: "Create an API key",
        description: "The full key is in this response only. MemDot keeps a hash.",
        security: authenticated,
        middleware: [requireScope("keys", "write"), requireAccountWide] as const,
        request: { body: { content: jsonContent(CreateKey), required: true } },
        responses: {
          201: { description: "Created", content: jsonContent(NewKey) },
          ...errorResponses,
        },
      }),
      async (c) => {
        const principal = principalOf(c);
        assertFreshSession(principal);
        const accountId = accountOf(c);
        const body = c.req.valid("json");
        for (const spaceId of body.spaceIds ?? []) await loadSpace(c, spaceId);
        if (body.agentId) {
          const [agent] = await db
            .select({ id: agents.id })
            .from(agents)
            .where(
              and(
                eq(agents.id, body.agentId),
                eq(agents.accountId, accountId),
                isNull(agents.revokedAt),
              ),
            );
          if (!agent) throw badRequest("AGENT", "That agent does not exist or was revoked.");
        }
        const key = await mint(principal.userId, {
          name: body.name,
          metadata: {
            role: body.role,
            spaceIds: body.spaceIds,
            ...(body.agentId ? { agentId: body.agentId } : {}),
          },
          expiresAt: body.expiresInDays
            ? new Date(Date.now() + body.expiresInDays * DAY_SECONDS * 1000)
            : null,
        });
        return c.json(key, 201);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/v1/keys/{id}/rotate",
        tags: ["API keys"],
        summary: "Rotate an API key",
        description:
          "Revokes the key first, then mints a new one with the same name, role, spaces and expiry. The old key stops working at once.",
        security: authenticated,
        middleware: [requireScope("keys", "write"), requireAccountWide] as const,
        request: {
          params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }) }),
        },
        responses: {
          201: { description: "Rotated", content: jsonContent(NewKey) },
          ...errorResponses,
        },
      }),
      async (c) => {
        const principal = principalOf(c);
        assertFreshSession(principal);
        const old = await loadKey(principal.userId, c.req.valid("param").id);
        await db.delete(apikey).where(eq(apikey.id, old.id));
        forgetApiKeys();
        const key = await mint(principal.userId, {
          name: old.name ?? "Rotated key",
          metadata: metadataOf(old),
          expiresAt: old.expiresAt,
        });
        return c.json(key, 201);
      },
    )
    .openapi(
      createRoute({
        method: "delete",
        path: "/v1/keys/{id}",
        tags: ["API keys"],
        summary: "Revoke an API key",
        security: authenticated,
        middleware: [requireScope("keys", "write"), requireAccountWide] as const,
        request: {
          params: z.object({ id: z.string().openapi({ param: { name: "id", in: "path" } }) }),
        },
        responses: {
          200: {
            description: "Revoked",
            content: jsonContent(z.object({ revoked: z.literal(true) })),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        const principal = principalOf(c);
        const key = await loadKey(principal.userId, c.req.valid("param").id);
        await db.delete(apikey).where(eq(apikey.id, key.id));
        forgetApiKeys();
        return c.json({ revoked: true as const }, 200);
      },
    );
}
