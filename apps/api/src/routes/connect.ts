import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import { sealTo } from "@memdot/crypto";
import { agents, apikey, connectRequests, folders } from "@memdot/db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db.js";
import { env } from "../env.js";
import { badRequest, conflict, HttpError, notFound } from "../lib/errors.js";
import { loadSpace } from "../lib/ownership.js";
import {
  accountOf,
  assertFreshSession,
  principalOf,
  requireAccountWide,
  requireScope,
} from "../lib/principal.js";
import { clientIp, RateLimiter, rateLimit } from "../lib/rate-limit.js";
import { authenticated, createRouter, errorResponses, jsonContent } from "../lib/router.js";
import { IdParam } from "../schemas.js";
import { AgentKey } from "./agents.js";
import { mint } from "./keys.js";

/** Long enough to find a passkey and pick spaces; a forgotten request stops being approvable. */
const REQUEST_TTL_MS = 10 * 60 * 1000;
const POLL_INTERVAL_SECONDS = 2;
const POLL_SECRET_BYTES = 32;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_EXPIRY_DAYS = 365;
const KEY_NAME_MAX = 32;
/** No 0/O or 1/I/L: people read this off one screen and compare it with another. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_GROUP = 4;

const startLimiter = new RateLimiter(20, 60_000);
const pollLimiter = new RateLimiter(120, 60_000);

const hashSecret = (secret: string) => createHash("sha256").update(secret).digest();

function newCode(): string {
  const pick = () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  const group = () => Array.from({ length: CODE_GROUP }, pick).join("");
  return `${group()}-${group()}`;
}

const Pending = z
  .object({
    id: z.uuid(),
    code: z.string().openapi({ description: "Shown here and in the terminal, to compare" }),
    label: z.string(),
    client: z.string(),
    publicKey: z.string(),
    status: z.enum(["pending", "approved", "denied", "delivered", "expired"]),
    expiresAt: z.iso.datetime(),
  })
  .openapi("ConnectRequest");

type RequestRow = typeof connectRequests.$inferSelect;

const stateOf = (row: RequestRow): z.infer<typeof Pending>["status"] =>
  row.status === "pending" && row.expiresAt <= new Date() ? "expired" : row.status;

async function loadRequest(id: string): Promise<RequestRow> {
  const [row] = await db.select().from(connectRequests).where(eq(connectRequests.id, id)).limit(1);
  if (!row) throw notFound("Connect request");
  return row;
}

/**
 * `memdot login`: a device with a fresh key pair asks, the owner's browser decides. The owner's
 * client wraps space keys to that public key and creates the grants; this route then mints an API
 * key limited to those spaces and seals it to the same public key, so only the device that asked
 * can open what it collects.
 */
export function connectRoutes() {
  return createRouter()
    .openapi(
      createRoute({
        method: "post",
        path: "/v1/connect",
        tags: ["Agents"],
        summary: "Ask to connect a device",
        description:
          "Needs no sign-in: nothing happens until the owner approves it in their browser. Keep the poll secret; it is the only way to collect the result.",
        middleware: [rateLimit(startLimiter, (c) => `connect:${clientIp(c)}`)] as const,
        request: {
          body: {
            content: jsonContent(
              z
                .object({
                  publicKey: AgentKey,
                  label: z.string().trim().min(1).max(64),
                  client: z.string().trim().min(1).max(32),
                })
                .openapi("NewConnectRequest"),
            ),
            required: true,
          },
        },
        responses: {
          201: {
            description: "Waiting for the owner",
            content: jsonContent(
              z.object({
                id: z.uuid(),
                code: z.string(),
                url: z.string().openapi({ description: "Where the owner approves it" }),
                pollSecret: z.string(),
                pollIntervalSeconds: z.number().int(),
                expiresAt: z.iso.datetime(),
              }),
            ),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        const body = c.req.valid("json");
        const pollSecret = randomBytes(POLL_SECRET_BYTES).toString("base64url");
        const code = newCode();
        const [row] = await db
          .insert(connectRequests)
          .values({
            ...body,
            code,
            pollHash: hashSecret(pollSecret).toString("hex"),
            expiresAt: new Date(Date.now() + REQUEST_TTL_MS),
          })
          .returning();
        if (!row) throw new Error("connect request insert returned no row");
        const url = new URL("/connect", env.WEB_ORIGIN);
        url.searchParams.set("request", row.id);
        url.searchParams.set("code", code);
        return c.json(
          {
            id: row.id,
            code,
            url: url.toString(),
            pollSecret,
            pollIntervalSeconds: POLL_INTERVAL_SECONDS,
            expiresAt: row.expiresAt.toISOString(),
          },
          201,
        );
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/v1/connect/{id}",
        tags: ["Agents"],
        summary: "See what's asking to connect",
        security: authenticated,
        middleware: [requireScope("agents", "write"), requireAccountWide] as const,
        request: { params: IdParam },
        responses: {
          200: { description: "The request", content: jsonContent(Pending) },
          ...errorResponses,
        },
      }),
      async (c) => {
        accountOf(c);
        const row = await loadRequest(c.req.valid("param").id);
        return c.json(
          {
            id: row.id,
            code: row.code,
            label: row.label,
            client: row.client,
            publicKey: row.publicKey,
            status: stateOf(row),
            expiresAt: row.expiresAt.toISOString(),
          },
          200,
        );
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/v1/connect/{id}/approve",
        tags: ["Agents"],
        summary: "Approve a device",
        description:
          "Call this after registering the agent and creating its grants: only the owner's client can wrap the keys. Mints the device's API key and seals it to the device.",
        security: authenticated,
        middleware: [requireScope("agents", "write"), requireAccountWide] as const,
        request: {
          params: IdParam,
          body: {
            content: jsonContent(
              z
                .object({
                  agentId: z.uuid(),
                  role: z.enum(["read_only", "read_write"]).default("read_write"),
                  spaceIds: z.array(z.uuid()).min(1),
                  namespaceId: z.uuid().optional(),
                  expiresInDays: z.number().int().min(1).max(MAX_EXPIRY_DAYS).optional(),
                })
                .openapi("ApproveConnect"),
            ),
            required: true,
          },
        },
        responses: {
          200: {
            description: "Sealed, waiting for the device",
            content: jsonContent(z.object({ approved: z.literal(true) })),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        const principal = principalOf(c);
        assertFreshSession(principal);
        const accountId = accountOf(c);
        const { id } = c.req.valid("param");
        const body = c.req.valid("json");
        const request = await loadRequest(id);
        for (const spaceId of body.spaceIds) await loadSpace(c, spaceId);

        const [agent] = await db
          .select()
          .from(agents)
          .where(
            and(
              eq(agents.id, body.agentId),
              eq(agents.accountId, accountId),
              isNull(agents.revokedAt),
            ),
          )
          .limit(1);
        if (!agent || agent.publicKey !== request.publicKey) {
          throw badRequest("AGENT", "That agent doesn't belong to this request.");
        }
        if (body.namespaceId) {
          const [namespace] = await db
            .select({ id: folders.id })
            .from(folders)
            .where(
              and(
                eq(folders.id, body.namespaceId),
                inArray(folders.spaceId, body.spaceIds),
                sql`${folders.memoryMode} <> 'off'`,
                isNull(folders.deletedAt),
              ),
            );
          if (!namespace) {
            throw badRequest("NAMESPACE", "Pick a namespace in one of the chosen spaces.");
          }
        }

        // Taken first, so two tabs can't mint two keys for one device.
        const [claimed] = await db
          .update(connectRequests)
          .set({ status: "approved", accountId, agentId: agent.id })
          .where(
            and(
              eq(connectRequests.id, id),
              eq(connectRequests.status, "pending"),
              sql`${connectRequests.expiresAt} > now()`,
            ),
          )
          .returning({ id: connectRequests.id });
        if (!claimed) {
          throw conflict(
            "CONNECT_CLOSED",
            "This request was already answered or has expired. Run memdot login again.",
          );
        }

        const expiresAt = body.expiresInDays
          ? new Date(Date.now() + body.expiresInDays * DAY_MS)
          : null;
        try {
          const created = await mint(principal.userId, {
            name: request.label.slice(0, KEY_NAME_MAX),
            metadata: { role: body.role, spaceIds: body.spaceIds, agentId: agent.id },
            expiresAt,
          });
          const sealed = await sealTo(new TextEncoder().encode(created.key), [request.publicKey]);
          await db
            .update(agents)
            .set({
              role: body.role,
              spaceIds: body.spaceIds,
              namespaceId: body.namespaceId ?? null,
              expiresAt,
            })
            .where(eq(agents.id, agent.id));
          await db
            .update(connectRequests)
            .set({
              sealedKey: Buffer.from(sealed).toString("base64"),
              namespaceId: body.namespaceId ?? null,
            })
            .where(eq(connectRequests.id, id));
        } catch (error) {
          await db.delete(apikey).where(sql`${apikey.metadata}::jsonb ->> 'agentId' = ${agent.id}`);
          await db
            .update(connectRequests)
            .set({ status: "pending", accountId: null, agentId: null })
            .where(eq(connectRequests.id, id));
          throw error;
        }
        return c.json({ approved: true as const }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/v1/connect/{id}/deny",
        tags: ["Agents"],
        summary: "Refuse a device",
        security: authenticated,
        middleware: [requireScope("agents", "write"), requireAccountWide] as const,
        request: { params: IdParam },
        responses: {
          200: {
            description: "Refused",
            content: jsonContent(z.object({ denied: z.literal(true) })),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        accountOf(c);
        const { id } = c.req.valid("param");
        await db
          .update(connectRequests)
          .set({ status: "denied" })
          .where(and(eq(connectRequests.id, id), eq(connectRequests.status, "pending")));
        return c.json({ denied: true as const }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/v1/connect/{id}/poll",
        tags: ["Agents"],
        summary: "Collect the result",
        description:
          "The device asks until the owner has answered. The sealed key is handed over once and then forgotten.",
        middleware: [rateLimit(pollLimiter, (c) => `connect-poll:${clientIp(c)}`)] as const,
        request: {
          params: IdParam,
          body: {
            content: jsonContent(z.object({ pollSecret: z.string().min(1).max(128) })),
            required: true,
          },
        },
        responses: {
          200: {
            description: "Where it stands",
            content: jsonContent(
              z
                .object({
                  status: z.enum(["pending", "approved", "denied", "delivered", "expired"]),
                  sealedKey: z.string().nullable(),
                  agentId: z.uuid().nullable(),
                  namespaceId: z.uuid().nullable(),
                })
                .openapi("ConnectResult"),
            ),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        const row = await loadRequest(id);
        const presented = hashSecret(c.req.valid("json").pollSecret);
        const expected = Buffer.from(row.pollHash, "hex");
        if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
          throw new HttpError(403, "FORBIDDEN", "That isn't this request's poll secret.");
        }
        const empty = { sealedKey: null, agentId: null, namespaceId: null };
        const state = stateOf(row);
        // Approved, but the key isn't sealed yet: a moment more.
        if (state === "approved" && !row.sealedKey) {
          return c.json({ status: "pending" as const, ...empty }, 200);
        }
        if (state !== "approved") return c.json({ status: state, ...empty }, 200);

        const [taken] = await db
          .update(connectRequests)
          .set({ status: "delivered", sealedKey: null })
          .where(and(eq(connectRequests.id, id), eq(connectRequests.status, "approved")))
          .returning({ id: connectRequests.id });
        if (!taken) return c.json({ status: "delivered" as const, ...empty }, 200);
        return c.json(
          {
            status: "approved" as const,
            sealedKey: row.sealedKey,
            agentId: row.agentId,
            namespaceId: row.namespaceId,
          },
          200,
        );
      },
    );
}
