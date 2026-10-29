import { createRoute, z } from "@hono/zod-openapi";
import { agents, apikey, grants } from "@memdot/db";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db.js";
import { conflict, isUniqueViolation, notFound } from "../lib/errors.js";
import { accountOf, forgetApiKeys, requireAccountWide, requireScope } from "../lib/principal.js";
import { revokeGrants } from "../lib/revoke.js";
import { authenticated, createRouter, errorResponses, jsonContent } from "../lib/router.js";
import { IdParam } from "../schemas.js";

const AgentKey = z
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
    publicKey: z.string(),
    createdAt: z.iso.datetime(),
    lastUsedAt: z.iso.datetime().nullable(),
    revokedAt: z.iso.datetime().nullable(),
  })
  .openapi("Agent");

type AgentRow = typeof agents.$inferSelect;
const serialize = (row: AgentRow) => ({
  id: row.id,
  label: row.label,
  client: row.client,
  publicKey: row.publicKey,
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
        return c.json({ items: rows.map(serialize) }, 200);
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
        const body = c.req.valid("json");
        try {
          const [row] = await db
            .insert(agents)
            .values({ accountId: accountOf(c), ...body })
            .returning();
          if (!row) throw new Error("agent insert returned no row");
          return c.json(serialize(row), 201);
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
        return c.json(serialize(row), 200);
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
          const revoked = await revokeGrants(
            tx,
            and(eq(grants.granteeKind, "agent"), eq(grants.grantee, agent.publicKey)) ?? sql`false`,
          );
          return { keys: keys.length, grants: revoked };
        });
        forgetApiKeys();
        return c.json({ revoked: true as const, ...result }, 200);
      },
    );
}
