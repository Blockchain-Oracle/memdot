import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import { sealTo } from "@memdot/crypto";
import { accounts, agents, apikey, connectRequests, folders } from "@memdot/db";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
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
/** No 0/O or 1/I/L: people read this off one screen and type it into another. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_GROUP = 4;

const startLimiter = new RateLimiter(20, 60_000);
const claimLimiter = new RateLimiter(20, 60_000);
const pollLimiter = new RateLimiter(120, 60_000);

const hashSecret = (secret: string) => createHash("sha256").update(secret).digest();

function newCode(): string {
  const pick = () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  const group = () => Array.from({ length: CODE_GROUP }, pick).join("");
  return `${group()}-${group()}`;
}

/** However someone typed it: lower case, or without the dash. */
const normalizedCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, "");

function sameCode(typed: string, expected: string): boolean {
  const a = hashSecret(normalizedCode(typed));
  const b = hashSecret(normalizedCode(expected));
  return timingSafeEqual(a, b);
}

const Claimed = z
  .object({
    id: z.uuid(),
    label: z.string().openapi({ description: "What it calls itself. Nothing vouches for this." }),
    client: z.string(),
    publicKey: z.string(),
    requestedFrom: z.string().nullable().openapi({ description: "The address it asked from" }),
    status: z.enum(["pending", "approved", "denied", "delivered", "expired"]),
    expiresAt: z.iso.datetime(),
  })
  .openapi("ConnectRequest");

type RequestRow = typeof connectRequests.$inferSelect;

const stateOf = (row: RequestRow): z.infer<typeof Claimed>["status"] =>
  row.status === "pending" && row.expiresAt <= new Date() ? "expired" : row.status;

async function loadRequest(id: string): Promise<RequestRow> {
  const [row] = await db.select().from(connectRequests).where(eq(connectRequests.id, id)).limit(1);
  if (!row) throw notFound("Connect request");
  return row;
}

/**
 * `memdot login`: a device with a fresh key pair asks, and the owner's browser decides. The owner
 * types the code the terminal shows, which claims the request for their account: a link alone
 * reaches nothing, so someone can't be phished into one click. Their client then wraps space keys
 * to that public key and creates the grants, and this route mints an API key limited to those
 * spaces and seals it to the same public key, so only the device that asked can open what it
 * collects.
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
          "Needs no sign-in: nothing happens until the owner types the code in their browser and approves. Show them the code. Keep the poll secret; it is the only way to collect the result.",
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
                code: z.string().openapi({ description: "The owner types this into the page" }),
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
            requestedFrom: clientIp(c),
            expiresAt: new Date(Date.now() + REQUEST_TTL_MS),
          })
          .returning();
        if (!row) throw new Error("connect request insert returned no row");
        const url = new URL("/connect", env.WEB_ORIGIN);
        url.searchParams.set("request", row.id);
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
        method: "post",
        path: "/v1/connect/{id}/claim",
        tags: ["Agents"],
        summary: "Claim a device's request with its code",
        description:
          "The owner types the code the terminal shows. From then on only their account can answer it.",
        security: authenticated,
        middleware: [
          requireScope("agents", "write"),
          requireAccountWide,
          rateLimit(claimLimiter, (c) => `connect-claim:${clientIp(c)}`),
        ] as const,
        request: {
          params: IdParam,
          body: {
            content: jsonContent(z.object({ code: z.string().trim().min(1).max(32) })),
            required: true,
          },
        },
        responses: {
          200: { description: "The request", content: jsonContent(Claimed) },
          ...errorResponses,
        },
      }),
      async (c) => {
        const accountId = accountOf(c);
        const { id } = c.req.valid("param");
        const row = await loadRequest(id);
        if (!sameCode(c.req.valid("json").code, row.code)) {
          throw badRequest("CONNECT_CODE", "That code doesn't match. Check your terminal.");
        }
        const [claimed] = await db
          .update(connectRequests)
          .set({ accountId })
          .where(
            and(
              eq(connectRequests.id, id),
              or(isNull(connectRequests.accountId), eq(connectRequests.accountId, accountId)),
            ),
          )
          .returning();
        if (!claimed) {
          throw conflict("CONNECT_CLOSED", "Another account already answered this request.");
        }
        return c.json(
          {
            id: claimed.id,
            label: claimed.label,
            client: claimed.client,
            publicKey: claimed.publicKey,
            requestedFrom: claimed.requestedFrom,
            status: stateOf(claimed),
            expiresAt: claimed.expiresAt.toISOString(),
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
          "Call this after claiming the request, registering the agent and creating its grants: only the owner's client can wrap the keys. Mints the device's API key and seals it to the device.",
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

        // Taken first, so two tabs can't mint two keys for one device. Only the account that
        // claimed it with the code can do this.
        const [taken] = await db
          .update(connectRequests)
          .set({ status: "approved", agentId: agent.id })
          .where(
            and(
              eq(connectRequests.id, id),
              eq(connectRequests.accountId, accountId),
              eq(connectRequests.status, "pending"),
              sql`${connectRequests.expiresAt} > now()`,
            ),
          )
          .returning({ id: connectRequests.id });
        if (!taken) {
          throw conflict(
            "CONNECT_CLOSED",
            "This request was already answered or has expired. Run memdot login again.",
          );
        }

        const expiresAt = body.expiresInDays
          ? new Date(Date.now() + body.expiresInDays * DAY_MS)
          : null;
        let mintedId: string | null = null;
        try {
          const created = await mint(principal.userId, {
            name: request.label.slice(0, KEY_NAME_MAX),
            metadata: { role: body.role, spaceIds: body.spaceIds, agentId: agent.id },
            expiresAt,
          });
          mintedId = created.id;
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
          // Only the key made just now: an agent can already hold others.
          if (mintedId) await db.delete(apikey).where(eq(apikey.id, mintedId));
          await db
            .update(connectRequests)
            .set({ status: "pending", agentId: null })
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
        description: "Only the account that claimed the request can refuse it.",
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
        const { id } = c.req.valid("param");
        await db
          .update(connectRequests)
          .set({ status: "denied" })
          .where(
            and(
              eq(connectRequests.id, id),
              eq(connectRequests.accountId, accountOf(c)),
              eq(connectRequests.status, "pending"),
            ),
          );
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
                  ownerAccount: z.string().nullable().openapi({
                    description: "The account that approved it, so the device can say whose it is",
                  }),
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
        const empty = { sealedKey: null, agentId: null, namespaceId: null, ownerAccount: null };
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
        const [owner] = row.accountId
          ? await db
              .select({ ownerAccount: accounts.ownerAccount })
              .from(accounts)
              .where(eq(accounts.id, row.accountId))
          : [];
        return c.json(
          {
            status: "approved" as const,
            sealedKey: row.sealedKey,
            agentId: row.agentId,
            namespaceId: row.namespaceId,
            ownerAccount: owner?.ownerAccount ?? null,
          },
          200,
        );
      },
    );
}
