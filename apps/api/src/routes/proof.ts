import { createRoute, z } from "@hono/zod-openapi";
import { contentHashFromCid, toHex } from "@memdot/chain";
import { RETENTION_BLOCKS } from "@memdot/config";
import { objects, renewals, storedItems } from "@memdot/db";
import { and, count, desc, eq, isNotNull, sum } from "drizzle-orm";
import { db } from "../db.js";
import { notFound } from "../lib/errors.js";
import { clientIp, RateLimiter, rateLimit } from "../lib/rate-limit.js";
import { createRouter, errorResponses, jsonContent } from "../lib/router.js";
import { Cid, TxHash } from "../schemas.js";
import type { Services } from "../types.js";

// Public, read-only evidence of what MemDot stored and renewed on Portaldot V3. Everything here
// is already public on chain; account and space ids are never included.

const PROOF_RATE = { max: 600, windowMs: 60_000 };
const RECENT_LIMIT = 20;

const Location = z.object({
  block: z.number().int(),
  index: z.number().int(),
  txHash: z.string().nullable(),
});

const Renewal = z.object({
  txHash: z.string(),
  from: z.object({ block: z.number().int(), index: z.number().int() }),
  to: z.object({ block: z.number().int(), index: z.number().int() }),
  at: z.iso.datetime(),
});

const CidProof = z
  .object({
    cid: z.string(),
    contentHash: z.string(),
    sizeBytes: z.number().int(),
    kind: z.string().nullable().openapi({ description: "file, segment, key_bundle…" }),
    role: z.enum(["root", "chunk"]),
    status: z.string(),
    current: Location.nullable(),
    firstStore: Location.nullable(),
    renewals: z.array(Renewal),
    expiresAtBlock: z.number().int().nullable(),
    headBlock: z.number().int().nullable(),
  })
  .openapi("CidProof");

const TxProof = z
  .object({
    txHash: z.string(),
    type: z.enum(["store", "renew"]),
    cid: z.string(),
    sizeBytes: z.number().int(),
    location: z.object({ block: z.number().int(), index: z.number().int() }),
  })
  .openapi("TxProof");

const Stats = z
  .object({
    storedBlobs: z.number().int(),
    storedBytes: z.number().int(),
    renewals: z.number().int(),
    headBlock: z.number().int().nullable(),
  })
  .openapi("ProofStats");

const Recent = z
  .object({
    items: z.array(
      z.object({
        type: z.enum(["store", "renew"]),
        txHash: z.string(),
        cid: z.string(),
        block: z.number().int(),
        at: z.iso.datetime(),
      }),
    ),
  })
  .openapi("ProofRecent");

export function proofRoutes(services: Services) {
  const limiter = new RateLimiter(PROOF_RATE.max, PROOF_RATE.windowMs);
  const limited = rateLimit(limiter, (c) => `proof:${clientIp(c)}`);

  return createRouter()
    .openapi(
      createRoute({
        method: "get",
        path: "/v1/proof/cid/{cid}",
        tags: ["Proof"],
        summary: "Where a CID lives on Portaldot V3 and every renewal",
        middleware: [limited] as const,
        request: { params: z.object({ cid: Cid.openapi({ param: { name: "cid", in: "path" } }) }) },
        responses: {
          200: { description: "Proof", content: jsonContent(CidProof) },
          ...errorResponses,
        },
      }),
      async (c) => {
        const { cid } = c.req.valid("param");
        const hash = toHex(contentHashFromCid(cid));
        const [row] = await db
          .select({ item: storedItems, kind: objects.kind })
          .from(storedItems)
          .leftJoin(objects, eq(objects.id, storedItems.objectId))
          .where(eq(storedItems.contentHash, hash))
          .orderBy(desc(storedItems.createdAt))
          .limit(1);
        if (!row) throw notFound("CID");
        const history = await db
          .select()
          .from(renewals)
          .where(eq(renewals.storedItemId, row.item.id))
          .orderBy(renewals.createdAt);
        const first = history[0];
        const { item } = row;
        return c.json(
          {
            cid: item.cid,
            contentHash: item.contentHash,
            sizeBytes: item.sizeBytes,
            kind: row.kind,
            role: item.role,
            status: item.status,
            current:
              item.block !== null && item.idx !== null
                ? {
                    block: item.block,
                    index: item.idx,
                    txHash: history.at(-1)?.txHash ?? item.storedTxHash,
                  }
                : null,
            firstStore: first
              ? { block: first.fromBlock, index: first.fromIdx, txHash: item.storedTxHash }
              : item.block !== null && item.idx !== null
                ? { block: item.block, index: item.idx, txHash: item.storedTxHash }
                : null,
            renewals: history.map((r) => ({
              txHash: r.txHash,
              from: { block: r.fromBlock, index: r.fromIdx },
              to: { block: r.toBlock, index: r.toIdx },
              at: r.createdAt.toISOString(),
            })),
            expiresAtBlock: item.block === null ? null : item.block + RETENTION_BLOCKS,
            headBlock: services.chainHead.block,
          },
          200,
        );
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/v1/proof/tx/{hash}",
        tags: ["Proof"],
        summary: "What a MemDot transaction stored or renewed",
        middleware: [limited] as const,
        request: {
          params: z.object({ hash: TxHash.openapi({ param: { name: "hash", in: "path" } }) }),
        },
        responses: {
          200: { description: "Proof", content: jsonContent(TxProof) },
          ...errorResponses,
        },
      }),
      async (c) => {
        const { hash } = c.req.valid("param");
        const [renewal] = await db
          .select({ renewal: renewals, item: storedItems })
          .from(renewals)
          .innerJoin(storedItems, eq(storedItems.id, renewals.storedItemId))
          .where(eq(renewals.txHash, hash))
          .limit(1);
        if (renewal) {
          return c.json(
            {
              txHash: hash,
              type: "renew" as const,
              cid: renewal.item.cid,
              sizeBytes: renewal.item.sizeBytes,
              location: { block: renewal.renewal.toBlock, index: renewal.renewal.toIdx },
            },
            200,
          );
        }
        const [store] = await db
          .select()
          .from(storedItems)
          .where(eq(storedItems.storedTxHash, hash))
          .limit(1);
        if (!store) throw notFound("Transaction");
        const [first] = await db
          .select()
          .from(renewals)
          .where(eq(renewals.storedItemId, store.id))
          .orderBy(renewals.createdAt)
          .limit(1);
        return c.json(
          {
            txHash: hash,
            type: "store" as const,
            cid: store.cid,
            sizeBytes: store.sizeBytes,
            location: first
              ? { block: first.fromBlock, index: first.fromIdx }
              : { block: store.block ?? 0, index: store.idx ?? 0 },
          },
          200,
        );
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/v1/proof/stats",
        tags: ["Proof"],
        summary: "Totals for the live on-chain usage strip",
        middleware: [limited] as const,
        responses: {
          200: { description: "Stats", content: jsonContent(Stats) },
          ...errorResponses,
        },
      }),
      async (c) => {
        const [stored] = await db
          .select({ n: count(), bytes: sum(storedItems.sizeBytes) })
          .from(storedItems)
          .where(eq(storedItems.status, "stored"));
        const [renewed] = await db.select({ n: count() }).from(renewals);
        return c.json(
          {
            storedBlobs: stored?.n ?? 0,
            storedBytes: Number(stored?.bytes ?? 0),
            renewals: renewed?.n ?? 0,
            headBlock: services.chainHead.block,
          },
          200,
        );
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/v1/proof/recent",
        tags: ["Proof"],
        summary: "The latest stores and renewals",
        middleware: [limited] as const,
        responses: {
          200: { description: "Recent", content: jsonContent(Recent) },
          ...errorResponses,
        },
      }),
      async (c) => {
        const stores = await db
          .select({
            txHash: storedItems.storedTxHash,
            cid: storedItems.cid,
            block: storedItems.block,
            at: storedItems.createdAt,
          })
          .from(storedItems)
          .where(and(isNotNull(storedItems.storedTxHash), isNotNull(storedItems.block)))
          .orderBy(desc(storedItems.createdAt))
          .limit(RECENT_LIMIT);
        const renews = await db
          .select({
            txHash: renewals.txHash,
            cid: storedItems.cid,
            block: renewals.toBlock,
            at: renewals.createdAt,
          })
          .from(renewals)
          .innerJoin(storedItems, eq(storedItems.id, renewals.storedItemId))
          .orderBy(desc(renewals.createdAt))
          .limit(RECENT_LIMIT);
        const items = [
          ...stores.map((s) => ({ ...s, type: "store" as const })),
          ...renews.map((r) => ({ ...r, type: "renew" as const })),
        ]
          .filter(
            (i): i is typeof i & { txHash: string; block: number } =>
              !!i.txHash && i.block !== null,
          )
          .sort((a, b) => b.at.getTime() - a.at.getTime())
          .slice(0, RECENT_LIMIT)
          .map((i) => ({
            type: i.type,
            txHash: i.txHash,
            cid: i.cid,
            block: i.block,
            at: i.at.toISOString(),
          }));
        return c.json({ items }, 200);
      },
    );
}
