import { randomBytes } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import { webhookDeliveries, webhooks } from "@memdot/db";
import { queueDelivery, WEBHOOK_EVENTS } from "@memdot/jobs";
import { assertPublicUrl, BlockedAddressError } from "@memdot/memory-server";
import { and, desc, eq } from "drizzle-orm";
import type { Context } from "hono";
import { db } from "../db.js";
import { badRequest, notFound } from "../lib/errors.js";
import { accountOf, requireAccountWide, requireScope } from "../lib/principal.js";
import { authenticated, createRouter, errorResponses, jsonContent } from "../lib/router.js";
import { IdParam } from "../schemas.js";
import type { AppEnv, Services } from "../types.js";

const SECRET_BYTES = 32;
const SECRET_PREFIX = "whsec_";
const DELIVERIES_SHOWN = 50;

const Events = z.array(z.enum(WEBHOOK_EVENTS)).min(1);

const Webhook = z
  .object({
    id: z.uuid(),
    name: z.string(),
    url: z.string(),
    events: z.array(z.string()),
    active: z.boolean(),
    created_at: z.string(),
  })
  .openapi("Webhook");

const Delivery = z
  .object({
    id: z.uuid(),
    event: z.string(),
    status: z.enum(["pending", "delivered", "failed"]),
    attempts: z.number().int(),
    response_status: z.number().int().nullable(),
    latency_ms: z.number().int().nullable(),
    error: z.string().nullable(),
    payload: z.record(z.string(), z.unknown()),
    created_at: z.string(),
  })
  .openapi("WebhookDelivery");

const serialize = (row: typeof webhooks.$inferSelect): z.infer<typeof Webhook> => ({
  id: row.id,
  name: row.name,
  url: row.url,
  events: row.events,
  active: row.active,
  created_at: row.createdAt.toISOString(),
});

/** It's about to be sent to on the server's behalf, so it can't point inside our network. */
async function checkUrl(url: string) {
  if (!url.startsWith("https://")) {
    throw badRequest("BAD_ADDRESS", "A webhook has to be an https:// address.");
  }
  try {
    await assertPublicUrl(url);
  } catch (error) {
    if (error instanceof BlockedAddressError) throw badRequest("BLOCKED_ADDRESS", error.message);
    throw badRequest("BAD_ADDRESS", `Couldn't reach ${url}.`);
  }
}

async function load(c: Context<AppEnv>, id: string) {
  const [row] = await db
    .select()
    .from(webhooks)
    .where(and(eq(webhooks.id, id), eq(webhooks.accountId, accountOf(c))));
  if (!row) throw notFound("Webhook");
  return row;
}

const newSecret = () => `${SECRET_PREFIX}${randomBytes(SECRET_BYTES).toString("base64url")}`;

export function webhookRoutes(services: Services) {
  const keys = services.memoryKeys;
  // Every space's events go to a webhook, so a key limited to some spaces can't see or change them.
  const read = requireScope("usage", "read");
  // Whoever can add one chooses where this account's events go.
  const manage = requireScope("keys", "write");

  return createRouter()
    .openapi(
      createRoute({
        method: "get",
        path: "/v1/webhooks",
        tags: ["Webhooks"],
        summary: "Your webhooks",
        security: authenticated,
        middleware: [read, requireAccountWide] as const,
        responses: {
          200: {
            description: "Webhooks",
            content: jsonContent(z.object({ items: z.array(Webhook) })),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        const rows = await db
          .select()
          .from(webhooks)
          .where(eq(webhooks.accountId, accountOf(c)))
          .orderBy(desc(webhooks.createdAt));
        return c.json({ items: rows.map(serialize) }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/v1/webhooks",
        tags: ["Webhooks"],
        summary: "Add a webhook",
        description:
          "Deliveries are signed, and carry ids and event types only, never what a memory or file says. The signing secret is returned once, here.",
        security: authenticated,
        middleware: [manage, requireAccountWide] as const,
        request: {
          body: {
            content: jsonContent(
              z.object({ name: z.string().min(1).max(80), url: z.url().max(2000), events: Events }),
            ),
            required: true,
          },
        },
        responses: {
          201: {
            description: "Created, with its signing secret",
            content: jsonContent(Webhook.extend({ secret: z.string() })),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        const body = c.req.valid("json");
        await checkUrl(body.url);
        const accountId = accountOf(c);
        const secret = newSecret();
        const [row] = await db
          .insert(webhooks)
          .values({
            accountId,
            name: body.name,
            url: body.url,
            events: body.events,
            secretSealed: keys.sealForAccount(accountId, secret),
          })
          .returning();
        return c.json({ ...serialize(row as typeof webhooks.$inferSelect), secret }, 201);
      },
    )
    .openapi(
      createRoute({
        method: "patch",
        path: "/v1/webhooks/{id}",
        tags: ["Webhooks"],
        summary: "Change a webhook, or pause it",
        security: authenticated,
        middleware: [manage, requireAccountWide] as const,
        request: {
          params: IdParam,
          body: {
            content: jsonContent(
              z.object({
                name: z.string().min(1).max(80).optional(),
                url: z.url().max(2000).optional(),
                events: Events.optional(),
                active: z.boolean().optional(),
              }),
            ),
            required: true,
          },
        },
        responses: {
          200: { description: "Changed", content: jsonContent(Webhook) },
          ...errorResponses,
        },
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        const body = c.req.valid("json");
        await load(c, id);
        if (body.url) await checkUrl(body.url);
        const [row] = await db
          .update(webhooks)
          .set({ ...body, updatedAt: new Date() })
          .where(eq(webhooks.id, id))
          .returning();
        return c.json(serialize(row as typeof webhooks.$inferSelect), 200);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/v1/webhooks/{id}/rotate",
        tags: ["Webhooks"],
        summary: "Replace the signing secret",
        description: "The old secret stops at once. The new one is returned once, here.",
        security: authenticated,
        middleware: [manage, requireAccountWide] as const,
        request: { params: IdParam },
        responses: {
          200: {
            description: "The new secret",
            content: jsonContent(z.object({ secret: z.string() })),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        await load(c, id);
        const secret = newSecret();
        await db
          .update(webhooks)
          .set({ secretSealed: keys.sealForAccount(accountOf(c), secret), updatedAt: new Date() })
          .where(eq(webhooks.id, id));
        return c.json({ secret }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "delete",
        path: "/v1/webhooks/{id}",
        tags: ["Webhooks"],
        summary: "Remove a webhook, and its delivery log",
        security: authenticated,
        middleware: [manage, requireAccountWide] as const,
        request: { params: IdParam },
        responses: {
          200: {
            description: "Removed",
            content: jsonContent(z.object({ deleted: z.boolean() })),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        await load(c, id);
        await db.delete(webhooks).where(eq(webhooks.id, id));
        return c.json({ deleted: true }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/v1/webhooks/{id}/test",
        tags: ["Webhooks"],
        summary: "Send a test event",
        security: authenticated,
        middleware: [manage, requireAccountWide] as const,
        request: { params: IdParam },
        responses: {
          202: {
            description: "Queued",
            content: jsonContent(z.object({ delivery_id: z.uuid() })),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        await load(c, id);
        const delivery = await queueDelivery(services.boss, db, id, "webhook.test", {});
        return c.json({ delivery_id: delivery }, 202);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/v1/webhooks/{id}/deliveries",
        tags: ["Webhooks"],
        summary: "What was sent, and how it went",
        security: authenticated,
        middleware: [read, requireAccountWide] as const,
        request: { params: IdParam },
        responses: {
          200: {
            description: "Deliveries, newest first",
            content: jsonContent(z.object({ items: z.array(Delivery) })),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        const { id } = c.req.valid("param");
        await load(c, id);
        const rows = await db
          .select()
          .from(webhookDeliveries)
          .where(eq(webhookDeliveries.webhookId, id))
          .orderBy(desc(webhookDeliveries.createdAt))
          .limit(DELIVERIES_SHOWN);
        return c.json(
          {
            items: rows.map((row) => ({
              id: row.id,
              event: row.event,
              status: row.status as "pending" | "delivered" | "failed",
              attempts: row.attempts,
              response_status: row.responseStatus,
              latency_ms: row.latencyMs,
              error: row.error,
              payload: row.payload as Record<string, unknown>,
              created_at: row.createdAt.toISOString(),
            })),
          },
          200,
        );
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/v1/webhooks/{id}/deliveries/{deliveryId}/resend",
        tags: ["Webhooks"],
        summary: "Send an event again",
        description: "As a new delivery, with the same event and ids.",
        security: authenticated,
        middleware: [manage, requireAccountWide] as const,
        request: { params: IdParam.extend({ deliveryId: z.uuid() }) },
        responses: {
          202: {
            description: "Queued",
            content: jsonContent(z.object({ delivery_id: z.uuid() })),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        const { id, deliveryId } = c.req.valid("param");
        await load(c, id);
        const [original] = await db
          .select()
          .from(webhookDeliveries)
          .where(and(eq(webhookDeliveries.id, deliveryId), eq(webhookDeliveries.webhookId, id)));
        if (!original) throw notFound("Delivery");
        const delivery = await queueDelivery(
          services.boss,
          db,
          id,
          original.event as "webhook.test",
          original.payload as Record<string, never>,
        );
        return c.json({ delivery_id: delivery }, 202);
      },
    );
}
