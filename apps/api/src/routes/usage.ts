import { createRoute, z } from "@hono/zod-openapi";
import { RENEW_AT_FRACTION, RETENTION_BLOCKS } from "@memdot/config";
import { objects, renewals, spaces, storedItems } from "@memdot/db";
import { and, asc, count, eq, isNull, min, sql, sum } from "drizzle-orm";
import { db } from "../db.js";
import { accountOf, requireScope } from "../lib/principal.js";
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
      const ownBlobs = and(eq(objects.accountId, accountId), eq(objects.id, storedItems.objectId));

      const spaceRows = await db
        .select({
          id: spaces.id,
          mode: spaces.mode,
          quotaBytes: spaces.quotaBytes,
          usedBytes: spaces.usedBytes,
        })
        .from(spaces)
        .where(and(eq(spaces.accountId, accountId), isNull(spaces.deletedAt)))
        .orderBy(asc(spaces.createdAt));

      const byStatus = await db
        .select({ status: storedItems.status, n: count(), bytes: sum(storedItems.sizeBytes) })
        .from(storedItems)
        .innerJoin(objects, ownBlobs)
        .groupBy(storedItems.status);
      const tally = (status: string) => byStatus.find((row) => row.status === status);

      const [storeFees] = await db
        .select({ planck: sql<string | null>`sum(${storedItems.feePlanck}::numeric)::text` })
        .from(storedItems)
        .innerJoin(objects, ownBlobs);
      const [renewTotals] = await db
        .select({
          n: count(),
          planck: sql<string | null>`sum(${renewals.feePlanck}::numeric)::text`,
        })
        .from(renewals)
        .innerJoin(storedItems, eq(storedItems.id, renewals.storedItemId))
        .innerJoin(objects, ownBlobs);
      const [next] = await db
        .select({ block: min(storedItems.block) })
        .from(storedItems)
        .innerJoin(objects, ownBlobs)
        .where(eq(storedItems.status, "stored"));

      const spent = BigInt(storeFees?.planck ?? "0") + BigInt(renewTotals?.planck ?? "0");
      return c.json(
        {
          spaces: spaceRows,
          blobs: {
            stored: tally("stored")?.n ?? 0,
            pending: tally("pending")?.n ?? 0,
            expiredServed: tally("expired_served")?.n ?? 0,
            lost: tally("lost")?.n ?? 0,
          },
          storedBytes: Number(tally("stored")?.bytes ?? 0),
          renewals: renewTotals?.n ?? 0,
          spentPlanck: spent.toString(),
          nextRenewalBlock: next?.block == null ? null : next.block + RENEW_DUE_OFFSET,
          headBlock: services.chainHead.block,
        },
        200,
      );
    },
  );
}
