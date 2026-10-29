import { createRoute, z } from "@hono/zod-openapi";
import { sql } from "drizzle-orm";
import { db } from "../db.js";
import { createRouter } from "../lib/router.js";
import type { Services } from "../types.js";

/** Readiness gives each dependency this long before it counts as down. */
const CHECK_TIMEOUT_MS = 3_000;

const Live = z.object({ ok: z.literal(true) }).openapi("Live");
const Ready = z
  .object({
    ok: z.boolean(),
    database: z.boolean(),
    chain: z.boolean(),
    block: z.number().int().nullable(),
  })
  .openapi("Ready");

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("timeout")), CHECK_TIMEOUT_MS).unref(),
    ),
  ]);
}

export function healthRoutes(services: Services) {
  return createRouter()
    .openapi(
      createRoute({
        method: "get",
        path: "/live",
        tags: ["Health"],
        summary: "The process is up",
        responses: {
          200: { description: "Alive", content: { "application/json": { schema: Live } } },
        },
      }),
      (c) => c.json({ ok: true as const }, 200),
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/ready",
        tags: ["Health"],
        summary: "Database and Portaldot V3 are reachable",
        responses: {
          200: { description: "Ready", content: { "application/json": { schema: Ready } } },
          503: { description: "Not ready", content: { "application/json": { schema: Ready } } },
        },
      }),
      async (c) => {
        const database = await withTimeout(db.execute(sql`select 1`))
          .then(() => true)
          .catch(() => false);
        const block = await withTimeout(services.chain.client.getFinalizedBlock())
          .then((b) => b.number)
          .catch(() => null);
        const body = { ok: database && block !== null, database, chain: block !== null, block };
        return c.json(body, body.ok ? 200 : 503);
      },
    );
}
