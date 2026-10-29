import { createRoute, z } from "@hono/zod-openapi";
import { bitswapGet, contentHashFromCid, IntegrityError, toHex } from "@memdot/chain";
import { blobStaging, storedItems } from "@memdot/db";
import { eq } from "drizzle-orm";
import { db } from "../db.js";
import { HttpError } from "../lib/errors.js";
import { clientIp, RateLimiter, rateLimit } from "../lib/rate-limit.js";
import { createRouter, errorResponses } from "../lib/router.js";
import { Cid } from "../schemas.js";
import type { Services } from "../types.js";

const GATEWAY_RATE = { max: 300, windowMs: 60_000 };
/** Content-addressed bytes never change, so clients and CDNs may keep them forever. */
const IMMUTABLE = "public, max-age=31536000, immutable";

type Source = "staging" | "cache" | "chain";

async function staged(cid: string): Promise<Uint8Array | null> {
  const [row] = await db
    .select({ data: blobStaging.data })
    .from(blobStaging)
    .innerJoin(storedItems, eq(storedItems.id, blobStaging.storedItemId))
    .where(eq(storedItems.contentHash, toHex(contentHashFromCid(cid))))
    .limit(1);
  return row?.data ?? null;
}

export function gatewayRoutes(services: Services) {
  const cache = services.gatewayCache;
  const limiter = new RateLimiter(GATEWAY_RATE.max, GATEWAY_RATE.windowMs);

  async function read(cid: string): Promise<{ bytes: Uint8Array; source: Source }> {
    const pending = await staged(cid);
    if (pending) return { bytes: pending, source: "staging" };
    const cached = await cache.get(cid);
    if (cached) return { bytes: cached, source: "cache" };
    try {
      const bytes = await bitswapGet(services.chain.client, cid);
      await cache.put(cid, bytes);
      return { bytes, source: "chain" };
    } catch (error) {
      if (error instanceof IntegrityError) {
        throw new HttpError(
          502,
          "INTEGRITY",
          "The node returned bytes that do not match this CID.",
        );
      }
      throw new HttpError(
        504,
        "NOT_RETRIEVABLE",
        "No Portaldot node returned these bytes in time. They may have expired or not be stored yet.",
      );
    }
  }

  return createRouter().openapi(
    createRoute({
      method: "get",
      path: "/v1/cids/{cid}",
      tags: ["Gateway"],
      summary: "Read stored bytes by CID",
      description:
        "Public. Returns ciphertext exactly as stored on Portaldot V3 (read with `bitswap_v1_get` and checked against the CID). Decrypt on the client. Verify independently over your own RPC connection.",
      middleware: [rateLimit(limiter, (c) => `gateway:${clientIp(c)}`)] as const,
      request: { params: z.object({ cid: Cid.openapi({ param: { name: "cid", in: "path" } }) }) },
      responses: {
        200: {
          description: "The stored bytes",
          content: {
            "application/octet-stream": { schema: z.string().openapi({ format: "binary" }) },
          },
        },
        304: { description: "Unchanged (ETag matched)" },
        ...errorResponses,
        502: { description: "A node returned bytes that do not match the CID" },
        504: { description: "Not retrievable right now" },
      },
    }),
    async (c) => {
      const { cid } = c.req.valid("param");
      const etag = `"${cid}"`;
      if (c.req.header("if-none-match") === etag) return c.body(null, 304);
      const { bytes, source } = await read(cid);
      // Node buffers here are never shared memory, so the narrower view type is safe.
      return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
        "content-type": "application/octet-stream",
        "content-length": String(bytes.length),
        "cache-control": source === "staging" ? "no-store" : IMMUTABLE,
        etag,
        "x-memdot-source": source,
      });
    },
  );
}
