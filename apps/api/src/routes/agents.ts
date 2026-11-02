import { createRoute, z } from "@hono/zod-openapi";
import { MAX_SPACES_PER_ACCOUNT } from "@memdot/config";
import {
  agents,
  apikey,
  folders,
  grants,
  oauthAccessToken,
  oauthClient,
  oauthConsent,
  oauthRefreshToken,
} from "@memdot/db";
import { and, desc, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import { db } from "../db.js";
import { badRequest, conflict, isUniqueViolation, notFound } from "../lib/errors.js";
import { loadSpace } from "../lib/ownership.js";
import {
  accountOf,
  assertFreshSession,
  forgetApiKeys,
  principalOf,
  requireAccountWide,
  requireScope,
} from "../lib/principal.js";
import { revokeGrants } from "../lib/revoke.js";
import { authenticated, createRouter, errorResponses, jsonContent } from "../lib/router.js";
import { IdParam } from "../schemas.js";

export const AgentKey = z
  .string()
  .regex(/^age1[0-9a-z]{58}$/, "Expected the agent's age X25519 recipient.")
  .openapi({
    description: "The agent's X25519 public key (age recipient); grants are wrapped to it",
  });

const Agent = z
  .object({
    id: z.uuid(),
    label: z.string(),
    client: z.string().openapi({ example: "claude-code" }),
    kind: z.enum(["device", "hosted"]).openapi({
      description:
        "device: holds its own key on the machine it runs on, so it can read Private namespaces. hosted: connected over OAuth, reaches Assisted namespaces only.",
    }),
    publicKey: z.string().nullable(),
    role: z.enum(["read_only", "read_write"]).nullable(),
    spaceIds: z.array(z.uuid()).nullable(),
    namespaceId: z.uuid().nullable().openapi({ description: "Where it remembers by default" }),
    expiresAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    lastUsedAt: z.iso.datetime().nullable(),
    revokedAt: z.iso.datetime().nullable(),
  })
  .openapi("Agent");

type AgentRow = typeof agents.$inferSelect;
export const serializeAgent = (row: AgentRow) => ({
  id: row.id,
  label: row.label,
  client: row.client,
  kind: row.oauthClientId ? ("hosted" as const) : ("device" as const),
  publicKey: row.publicKey,
  role: row.role,
  spaceIds: row.spaceIds,
  namespaceId: row.namespaceId,
  expiresAt: row.expiresAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
  lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  revokedAt: row.revokedAt?.toISOString() ?? null,
});

async function loadAgent(accountId: string, id: string) {
  const [row] = await db
    .select()
    .from(agents)
    .where(and(eq(agents.id, id), eq(agents.accountId, accountId)))
    .limit(1);
  if (!row) throw notFound("Agent");
  return row;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_EXPIRY_DAYS = 365;

export function agentRoutes() {
  return createRouter()
    .openapi(
      createRoute({
        method: "get",
        path: "/v1/agents",
        tags: ["Agents"],
        summary: "List connected agents",
        security: authenticated,
        middleware: [requireScope("agents", "read"), requireAccountWide] as const,
        responses: {
          200: { description: "Agents", content: jsonContent(z.object({ items: z.array(Agent) })) },
          ...errorResponses,
        },
      }),
      async (c) => {
        const rows = await db
          .select()
          .from(agents)
          .where(eq(agents.accountId, accountOf(c)))
          .orderBy(desc(agents.createdAt));
        return c.json({ items: rows.map(serializeAgent) }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/v1/agents",
        tags: ["Agents"],
        summary: "Register an agent's key",
        description:
          "Step one of connecting an agent: its public key is registered here, then the owner's client wraps namespace keys to it and creates grants.",
        security: authenticated,
        middleware: [requireScope("agents", "write"), requireAccountWide] as const,
        request: {
          body: {
            content: jsonContent(
              z
                .object({
                  label: z.string().trim().min(1).max(64),
                  client: z.string().trim().min(1).max(32),
                  publicKey: AgentKey,
                })
                .openapi("NewAgent"),
            ),
            required: true,
          },
        },
        responses: {
          201: { description: "Registered", content: jsonContent(Agent) },
          ...errorResponses,
        },
      }),
      async (c) => {
        // A new agent outlives this session, so a stolen cookie mustn't be enough.
        assertFreshSession(principalOf(c));
        const body = c.req.valid("json");
        try {
          const [row] = await db
            .insert(agents)
            .values({ accountId: accountOf(c), ...body })
            .returning();
          if (!row) throw new Error("agent insert returned no row");
          return c.json(serializeAgent(row), 201);
        } catch (error) {
          if (isUniqueViolation(error, "agents_key_idx")) {
            throw conflict("AGENT_KEY_TAKEN", "That key is already registered to an agent.");
          }
          throw error;
        }
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/v1/agents/hosted",
        tags: ["Agents"],
        summary: "Allow a hosted agent",
        description:
          "What the consent page sends just before it accepts an OAuth request: which spaces this client may reach and how. Assisted namespaces only, since nothing can be unwrapped for a client that holds no key. Asking again replaces what it had.",
        security: authenticated,
        middleware: [requireScope("agents", "write"), requireAccountWide] as const,
        request: {
          body: {
            content: jsonContent(
              z
                .object({
                  clientId: z.string().min(1).max(512),
                  role: z.enum(["read_only", "read_write"]).default("read_write"),
                  spaceIds: z.array(z.uuid()).min(1).max(MAX_SPACES_PER_ACCOUNT),
                  namespaces: z
                    .array(z.object({ id: z.uuid(), name: z.string().max(256).nullable() }))
                    .min(1)
                    .max(256)
                    .openapi({
                      description:
                        "The Assisted namespaces it will see, with their names as the owner's browser opened them.",
                    }),
                  namespaceId: z.uuid(),
                  expiresInDays: z.number().int().min(1).max(MAX_EXPIRY_DAYS).optional(),
                })
                .openapi("NewHostedAgent"),
            ),
            required: true,
          },
        },
        responses: {
          200: { description: "Allowed", content: jsonContent(Agent) },
          ...errorResponses,
        },
      }),
      async (c) => {
        assertFreshSession(principalOf(c));
        const accountId = accountOf(c);
        const body = c.req.valid("json");
        for (const spaceId of body.spaceIds) await loadSpace(c, spaceId);

        const [client] = await db
          .select({ name: oauthClient.name })
          .from(oauthClient)
          .where(eq(oauthClient.clientId, body.clientId))
          .limit(1);
        if (!client) throw notFound("OAuth client");

        const ids = body.namespaces.map((namespace) => namespace.id);
        const allowed = await db
          .select({ id: folders.id })
          .from(folders)
          .where(
            and(
              inArray(folders.id, ids),
              inArray(folders.spaceId, body.spaceIds),
              eq(folders.memoryMode, "assisted"),
              isNull(folders.deletedAt),
            ),
          );
        if (allowed.length !== new Set(ids).size || !ids.includes(body.namespaceId)) {
          throw badRequest(
            "NAMESPACE",
            "A hosted agent can only reach Assisted namespaces in the spaces you chose.",
          );
        }

        const values = {
          label: (client.name ?? "MCP client").slice(0, 64),
          client: "oauth",
          role: body.role,
          spaceIds: body.spaceIds,
          namespaces: body.namespaces,
          namespaceId: body.namespaceId,
          expiresAt: body.expiresInDays ? new Date(Date.now() + body.expiresInDays * DAY_MS) : null,
        };
        const row = await db.transaction(async (tx) => {
          const [existing] = await tx
            .select({ id: agents.id })
            .from(agents)
            .where(
              and(
                eq(agents.accountId, accountId),
                eq(agents.oauthClientId, body.clientId),
                isNull(agents.revokedAt),
              ),
            )
            .limit(1);
          const [saved] = existing
            ? await tx.update(agents).set(values).where(eq(agents.id, existing.id)).returning()
            : await tx
                .insert(agents)
                .values({ ...values, accountId, oauthClientId: body.clientId })
                .returning();
          return saved;
        });
        if (!row) throw new Error("agent upsert returned no row");
        forgetApiKeys();
        return c.json(serializeAgent(row), 200);
      },
    )
    .openapi(
      createRoute({
        method: "patch",
        path: "/v1/agents/{id}",
        tags: ["Agents"],
        summary: "Rename an agent",
        security: authenticated,
        middleware: [requireScope("agents", "write"), requireAccountWide] as const,
        request: {
          params: IdParam,
          body: {
            content: jsonContent(z.object({ label: z.string().trim().min(1).max(64) })),
            required: true,
          },
        },
        responses: {
          200: { description: "Agent", content: jsonContent(Agent) },
          ...errorResponses,
        },
      }),
      async (c) => {
        const agent = await loadAgent(accountOf(c), c.req.valid("param").id);
        const [row] = await db
          .update(agents)
          .set({ label: c.req.valid("json").label })
          .where(eq(agents.id, agent.id))
          .returning();
        if (!row) throw notFound("Agent");
        return c.json(serializeAgent(row), 200);
      },
    )
    .openapi(
      createRoute({
        method: "delete",
        path: "/v1/agents/{id}",
        tags: ["Agents"],
        summary: "Revoke an agent",
        description:
          "Deletes its API keys and revokes its grants at once; the affected spaces move to a new key epoch so future writes are unreadable to it.",
        security: authenticated,
        middleware: [requireScope("agents", "write"), requireAccountWide] as const,
        request: { params: IdParam },
        responses: {
          200: {
            description: "Revoked",
            content: jsonContent(
              z.object({
                revoked: z.literal(true),
                keys: z.number().int(),
                grants: z.number().int(),
              }),
            ),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        const agent = await loadAgent(accountOf(c), c.req.valid("param").id);
        const result = await db.transaction(async (tx) => {
          await tx.update(agents).set({ revokedAt: new Date() }).where(eq(agents.id, agent.id));
          const keys = await tx
            .delete(apikey)
            .where(sql`${apikey.metadata}::jsonb ->> 'agentId' = ${agent.id}`)
            .returning({ id: apikey.id });
          const revoked = agent.publicKey
            ? await revokeGrants(
                tx,
                and(eq(grants.granteeKind, "agent"), eq(grants.grantee, agent.publicKey)) as SQL,
              )
            : 0;
          // Hosted: its tokens go too, and connecting again asks the owner again.
          if (agent.oauthClientId) {
            const clientRows = and(
              eq(oauthAccessToken.clientId, agent.oauthClientId),
              eq(oauthAccessToken.userId, principalOf(c).userId),
            );
            await tx.delete(oauthAccessToken).where(clientRows);
            await tx
              .delete(oauthRefreshToken)
              .where(
                and(
                  eq(oauthRefreshToken.clientId, agent.oauthClientId),
                  eq(oauthRefreshToken.userId, principalOf(c).userId),
                ),
              );
            await tx
              .delete(oauthConsent)
              .where(
                and(
                  eq(oauthConsent.clientId, agent.oauthClientId),
                  eq(oauthConsent.userId, principalOf(c).userId),
                ),
              );
          }
          return { keys: keys.length, grants: revoked };
        });
        forgetApiKeys();
        return c.json({ revoked: true as const, ...result }, 200);
      },
    );
}
