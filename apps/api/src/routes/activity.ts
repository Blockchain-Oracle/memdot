import { createRoute, z } from "@hono/zod-openapi";
import { requestLogs } from "@memdot/db";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../db.js";
import { badRequest } from "../lib/errors.js";
import { afterCursor, encodeCursor, newestFirst, page } from "../lib/pagination.js";
import { accountOf, requireScope } from "../lib/principal.js";
import { authenticated, createRouter, errorResponses, jsonContent } from "../lib/router.js";
import { PageQuery, pageOf } from "../schemas.js";

const RequestEntry = z
  .object({
    id: z.number().int(),
    method: z.string(),
    path: z.string(),
    status: z.number().int(),
    latencyMs: z.number().int(),
    client: z.string().nullable(),
    apiKeyPrefix: z.string().nullable(),
    requestId: z.string(),
    createdAt: z.iso.datetime(),
  })
  .openapi("RequestLogEntry");

const ChainTx = z
  .object({
    id: z.string(),
    type: z.enum(["store", "renew"]),
    txHash: z.string(),
    cid: z.string(),
    block: z.number().int(),
    feePlanck: z.string().nullable(),
    at: z.iso.datetime(),
  })
  .openapi("ChainTransaction");

interface TxRow extends Record<string, unknown> {
  id: string;
  type: "store" | "renew";
  tx_hash: string;
  cid: string;
  block: number;
  fee_planck: string | null;
  at: Date;
}

function decodeTxCursor(cursor: string): { at: string; id: string } {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString()) as {
      t: string;
      id: string;
    };
    return { at: value.t, id: String(value.id) };
  } catch {
    throw badRequest("BAD_CURSOR", "That page cursor is not valid. Start from the first page.");
  }
}

export function activityRoutes() {
  return createRouter()
    .openapi(
      createRoute({
        method: "get",
        path: "/v1/activity/requests",
        tags: ["Activity"],
        summary: "Your API requests (metadata only: never bodies)",
        security: authenticated,
        middleware: [requireScope("usage", "read")] as const,
        request: { query: PageQuery },
        responses: {
          200: { description: "Requests", content: jsonContent(pageOf(RequestEntry)) },
          ...errorResponses,
        },
      }),
      async (c) => {
        const accountId = accountOf(c);
        const query = c.req.valid("query");
        const rows = await db
          .select()
          .from(requestLogs)
          .where(
            and(
              eq(requestLogs.accountId, accountId),
              afterCursor(query.cursor, requestLogs.createdAt, requestLogs.id),
            ),
          )
          .orderBy(...newestFirst(requestLogs.createdAt, requestLogs.id))
          .limit(query.limit + 1);
        const result = page(rows, query.limit);
        return c.json(
          {
            items: result.items.map((row) => ({
              id: row.id,
              method: row.method,
              path: row.path,
              status: row.status,
              latencyMs: row.latencyMs,
              client: row.client,
              apiKeyPrefix: row.apiKeyPrefix,
              requestId: row.requestId,
              createdAt: row.createdAt.toISOString(),
            })),
            nextCursor: result.nextCursor,
          },
          200,
        );
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/v1/activity/transactions",
        tags: ["Activity"],
        summary: "Every store and renewal on Portaldot V3 for your data",
        security: authenticated,
        middleware: [requireScope("usage", "read")] as const,
        request: { query: PageQuery },
        responses: {
          200: { description: "Transactions", content: jsonContent(pageOf(ChainTx)) },
          ...errorResponses,
        },
      }),
      async (c) => {
        const accountId = accountOf(c);
        const query = c.req.valid("query");
        const after = query.cursor ? decodeTxCursor(query.cursor) : null;
        const result = await db.execute<TxRow>(sql`
          select * from (
            select si.id::text as id, 'store' as type, si.stored_tx_hash as tx_hash, si.cid,
                   coalesce((select r.from_block from renewals r where r.stored_item_id = si.id
                             order by r.created_at limit 1), si.block) as block,
                   si.fee_planck, si.stored_at as at
              from stored_items si join objects o on o.id = si.object_id
             where o.account_id = ${accountId} and si.stored_tx_hash is not null and si.stored_at is not null
            union all
            select r.id::text, 'renew', r.tx_hash, si.cid, r.to_block, r.fee_planck, r.created_at
              from renewals r
              join stored_items si on si.id = r.stored_item_id
              join objects o on o.id = si.object_id
             where o.account_id = ${accountId}
          ) t
          ${after ? sql`where (t.at, t.id) < (${after.at}::timestamptz, ${after.id})` : sql``}
          order by t.at desc, t.id desc
          limit ${query.limit + 1}`);
        const rows = result.rows;
        const items = rows.slice(0, query.limit);
        const last = items.at(-1);
        return c.json(
          {
            items: items.map((row) => ({
              id: row.id,
              type: row.type,
              txHash: row.tx_hash,
              cid: row.cid,
              block: row.block,
              feePlanck: row.fee_planck,
              at: new Date(row.at).toISOString(),
            })),
            nextCursor:
              rows.length > query.limit && last ? encodeCursor(new Date(last.at), last.id) : null,
          },
          200,
        );
      },
    );
}
