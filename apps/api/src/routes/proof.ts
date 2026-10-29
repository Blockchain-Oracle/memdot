import { createRoute, z } from "@hono/zod-openapi";
import { contentHashFromCid, toHex } from "@memdot/chain";
import { RETENTION_BLOCKS } from "@memdot/config";
import { objects, renewals, storedItems } from "@memdot/db";
import { count, desc, eq, isNotNull, sum } from "drizzle-orm";
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
/** Public totals and the recent feed change slowly; they are computed at most twice a minute. */
const PUBLIC_CACHE_MS = 30_000;

/** One shared value, recomputed when stale; concurrent callers share one computation. */
class Cached<T> {
  private value: { data: T; at: number } | null = null;
  private pending: Promise<T> | null = null;

  async get(load: () => Promise<T>): Promise<T> {
    if (this.value && Date.now() - this.value.at < PUBLIC_CACHE_MS) return this.value.data;
    this.pending ??= load()
      .then((data) => {
        this.value = { data, at: Date.now() };
        return data;
      })
      .finally(() => {
        this.pending = null;
      });
    return this.pending;
  }
}

const statsCache = new Cached<{ storedBlobs: number; storedBytes: number; renewals: number }>();
type RecentItem = {
  type: "store" | "renew";
  txHash: string;
  cid: string;
  block: number;
  at: string;
};
const recentCache = new Cached<RecentItem[]>();

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
            firstStore:
              item.firstBlock !== null && item.firstIdx !== null
                ? { block: item.firstBlock, index: item.firstIdx, txHash: item.storedTxHash }
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
        return c.json(
          {
            txHash: hash,
            type: "store" as const,
            cid: store.cid,
            sizeBytes: store.sizeBytes,
            location: { block: store.firstBlock ?? 0, index: store.firstIdx ?? 0 },
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
        const totals = await statsCache.get(async () => {
          const [stored] = await db
            .select({ n: count(), bytes: sum(storedItems.sizeBytes) })
            .from(storedItems)
            .where(eq(storedItems.status, "stored"));
          const [renewed] = await db.select({ n: count() }).from(renewals);
          return {
            storedBlobs: stored?.n ?? 0,
            storedBytes: Number(stored?.bytes ?? 0),
            renewals: renewed?.n ?? 0,
          };
        });
        return c.json({ ...totals, headBlock: services.chainHead.block }, 200);
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
      async (c) => c.json({ items: await recentCache.get(loadRecent) }, 200),
    );
}

/** The latest stores and renewals, newest first, from the two indexed time columns. */
async function loadRecent() {
  const stores = await db
    .select({
      txHash: storedItems.storedTxHash,
      cid: storedItems.cid,
      block: storedItems.firstBlock,
      at: storedItems.storedAt,
    })
    .from(storedItems)
    .where(isNotNull(storedItems.storedTxHash))
    .orderBy(desc(storedItems.storedAt))
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
      (i): i is typeof i & { txHash: string; block: number; at: Date } =>
        !!i.txHash && i.block !== null && i.at !== null,
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
  return items;
}
