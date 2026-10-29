import { createRoute, z } from "@hono/zod-openapi";
import { RENEW_AT_FRACTION, RETENTION_BLOCKS } from "@memdot/config";
import { objects, renewals, spaces, storedItems } from "@memdot/db";
import { and, asc, count, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db.js";
import { accountOf, principalOf, requireScope } from "../lib/principal.js";
import { authenticated, createRouter, errorResponses, jsonContent } from "../lib/router.js";
import type { Services } from "../types.js";

const RENEW_DUE_OFFSET = Math.floor(RETENTION_BLOCKS * RENEW_AT_FRACTION);

const Usage = z
  .object({
    spaces: z.array(
      z.object({
        id: z.uuid(),
        mode: z.enum(["sponsored", "self_signed"]),
        quotaBytes: z.number().int(),
        usedBytes: z.number().int(),
      }),
    ),
    blobs: z.object({
      stored: z.number().int(),
      pending: z.number().int(),
      expiredServed: z.number().int(),
      lost: z.number().int(),
    }),
    storedBytes: z.number().int(),
    renewals: z.number().int(),
    spentPlanck: z
      .string()
      .openapi({ description: "tPOT spent on stores and renewals, in planck (14 decimals)" }),
    nextRenewalBlock: z.number().int().nullable(),
    headBlock: z.number().int().nullable(),
  })
  .openapi("Usage");

export function usageRoutes(services: Services) {
  return createRouter().openapi(
    createRoute({
      method: "get",
      path: "/v1/usage",
      tags: ["Usage"],
      summary: "Quotas, stored bytes, renewals and tPOT spent",
      security: authenticated,
      middleware: [requireScope("usage", "read")] as const,
      responses: { 200: { description: "Usage", content: jsonContent(Usage) }, ...errorResponses },
    }),
    async (c) => {
      const accountId = accountOf(c);
      const scope = principalOf(c).apiKey?.spaceIds ?? null;

      const spaceRows = await db
        .select({
          id: spaces.id,
          mode: spaces.mode,
          quotaBytes: spaces.quotaBytes,
          usedBytes: spaces.usedBytes,
        })
        .from(spaces)
        .where(
          and(
            eq(spaces.accountId, accountId),
            isNull(spaces.deletedAt),
            scope ? inArray(spaces.id, scope) : undefined,
          ),
        )
        .orderBy(asc(spaces.createdAt));

      // One pass over the account's blobs (indexed by account), narrowed for space-scoped keys.
      const itemScope = and(
        eq(storedItems.accountId, accountId),
        scope
          ? inArray(
              storedItems.objectId,
              db.select({ id: objects.id }).from(objects).where(inArray(objects.spaceId, scope)),
            )
          : undefined,
      );
      const [items] = await db
        .select({
          stored: sql<number>`count(*) filter (where ${storedItems.status} = 'stored')::int`,
          pending: sql<number>`count(*) filter (where ${storedItems.status} = 'pending')::int`,
          expiredServed: sql<number>`count(*) filter (where ${storedItems.status} = 'expired_served')::int`,
          lost: sql<number>`count(*) filter (where ${storedItems.status} = 'lost')::int`,
          storedBytes: sql<string>`coalesce(sum(${storedItems.sizeBytes}) filter (where ${storedItems.status} = 'stored'), 0)::text`,
          storePlanck: sql<string>`coalesce(sum(${storedItems.feePlanck}::numeric), 0)::text`,
          oldestBlock: sql<
            number | null
          >`min(${storedItems.block}) filter (where ${storedItems.status} = 'stored')`,
        })
        .from(storedItems)
        .where(itemScope);
      const [renewTotals] = await db
        .select({
          n: count(),
          planck: sql<string>`coalesce(sum(${renewals.feePlanck}::numeric), 0)::text`,
        })
        .from(renewals)
        .where(
          and(
            eq(renewals.accountId, accountId),
            scope
              ? inArray(
                  renewals.storedItemId,
                  db.select({ id: storedItems.id }).from(storedItems).where(itemScope),
                )
              : undefined,
          ),
        );

      const spent = BigInt(items?.storePlanck ?? "0") + BigInt(renewTotals?.planck ?? "0");
      return c.json(
        {
          spaces: spaceRows,
          blobs: {
            stored: items?.stored ?? 0,
            pending: items?.pending ?? 0,
            expiredServed: items?.expiredServed ?? 0,
            lost: items?.lost ?? 0,
          },
          storedBytes: Number(items?.storedBytes ?? 0),
          renewals: renewTotals?.n ?? 0,
          spentPlanck: spent.toString(),
          nextRenewalBlock:
            items?.oldestBlock == null ? null : items.oldestBlock + RENEW_DUE_OFFSET,
          headBlock: services.chainHead.block,
        },
        200,
      );
    },
  );
}
