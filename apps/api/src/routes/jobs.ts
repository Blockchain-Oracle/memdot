import { createRoute, z } from "@hono/zod-openapi";
import { jobs } from "@memdot/db";
import { type JobEvent, jobEventOf } from "@memdot/jobs";
import { and, eq, type SQL } from "drizzle-orm";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import { db } from "../db.js";
import { notFound } from "../lib/errors.js";
import { afterCursor, newestFirst, page } from "../lib/pagination.js";
import { accountOf, requireScope } from "../lib/principal.js";
import { authenticated, createRouter, errorResponses, jsonContent } from "../lib/router.js";
import { IdParam, PageQuery, pageOf } from "../schemas.js";
import type { AppEnv, Services } from "../types.js";

/** Comment lines keep proxies from closing an idle stream. */
const HEARTBEAT_MS = 15_000;
const TERMINAL = new Set(["finalized", "failed"]);

const Status = z.enum(["queued", "running", "submitted", "in_block", "finalized", "failed"]);

export const Job = z
  .object({
    id: z.uuid(),
    accountId: z.uuid().nullable(),
    kind: z.string().openapi({ example: "store_object" }),
    status: Status,
    txHash: z.string().nullable(),
    block: z.number().int().nullable(),
    error: z.string().nullable(),
    progress: z.object({ done: z.number().int(), total: z.number().int() }).nullable(),
    updatedAt: z.iso.datetime(),
  })
  .openapi("Job");

const sse = { "text/event-stream": { schema: z.string() } };

async function loadJob(accountId: string, id: string) {
  const [row] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, id), eq(jobs.accountId, accountId)))
    .limit(1);
  if (!row) throw notFound("Job");
  return row;
}

/**
 * One SSE stream. Sends a snapshot first, then every change; on "resync" (the LISTEN connection
 * was lost) it re-reads instead of guessing. Ends when `done` says so or the client leaves.
 */
function stream(
  c: Context<AppEnv>,
  subscribe: (push: (event: JobEvent | "resync") => void) => () => void,
  snapshot: () => Promise<JobEvent[]>,
  done: (event: JobEvent) => boolean,
) {
  return streamSSE(c, async (sse) => {
    let finished = false;
    let closeStream: () => void = () => {};
    const closed = new Promise<void>((resolve) => {
      closeStream = resolve;
    });
    const send = async (event: JobEvent) => {
      await sse.writeSSE({
        event: "job",
        id: `${event.id}:${event.updatedAt}`,
        data: JSON.stringify(event),
      });
      if (done(event)) {
        finished = true;
        closeStream();
      }
    };
    const resend = async () => {
      for (const event of await snapshot()) await send(event);
    };
    const unsubscribe = subscribe((event) => {
      if (finished) return;
      void (event === "resync" ? resend() : send(event)).catch(() => closeStream());
    });
    sse.onAbort(() => closeStream());
    const heartbeat = setInterval(
      () => void sse.write(": keep-alive\n\n").catch(() => closeStream()),
      HEARTBEAT_MS,
    );
    try {
      await resend();
      if (!finished) await closed;
    } finally {
      clearInterval(heartbeat);
      unsubscribe();
    }
  });
}

export function jobRoutes(services: Services) {
  return (
    createRouter()
      .openapi(
        createRoute({
          method: "get",
          path: "/v1/jobs",
          tags: ["Jobs"],
          summary: "List jobs, newest first",
          security: authenticated,
          middleware: [requireScope("jobs", "read")] as const,
          request: {
            query: PageQuery.extend({ status: Status.optional(), kind: z.string().optional() }),
          },
          responses: {
            200: { description: "Jobs", content: jsonContent(pageOf(Job)) },
            ...errorResponses,
          },
        }),
        async (c) => {
          const accountId = accountOf(c);
          const query = c.req.valid("query");
          const filters: (SQL | undefined)[] = [
            eq(jobs.accountId, accountId),
            query.status ? eq(jobs.status, query.status) : undefined,
            query.kind ? eq(jobs.kind, query.kind) : undefined,
            afterCursor(query.cursor, jobs.createdAt, jobs.id),
          ];
          const rows = await db
            .select()
            .from(jobs)
            .where(and(...filters))
            .orderBy(...newestFirst(jobs.createdAt, jobs.id))
            .limit(query.limit + 1);
          const result = page(rows, query.limit);
          return c.json(
            { items: result.items.map(jobEventOf), nextCursor: result.nextCursor },
            200,
          );
        },
      )
      // Registered before /v1/jobs/{id} so `events` is not read as a job id.
      .openapi(
        createRoute({
          method: "get",
          path: "/v1/jobs/events",
          tags: ["Jobs"],
          summary: "Follow every job of the account (Server-Sent Events)",
          description:
            "The dashboard's job tray: every change to any of your jobs, until you disconnect.",
          security: authenticated,
          middleware: [requireScope("jobs", "read")] as const,
          responses: {
            200: { description: "Event stream of Job", content: sse },
            ...errorResponses,
          },
        }),
        async (c) => {
          const accountId = accountOf(c);
          return stream(
            c,
            (push) => services.jobEvents.subscribeAccount(accountId, push),
            async () => [],
            () => false,
          );
        },
      )
      .openapi(
        createRoute({
          method: "get",
          path: "/v1/jobs/{id}",
          tags: ["Jobs"],
          summary: "A job's current state",
          security: authenticated,
          middleware: [requireScope("jobs", "read")] as const,
          request: { params: IdParam },
          responses: { 200: { description: "Job", content: jsonContent(Job) }, ...errorResponses },
        }),
        async (c) => c.json(jobEventOf(await loadJob(accountOf(c), c.req.valid("param").id)), 200),
      )
      .openapi(
        createRoute({
          method: "get",
          path: "/v1/jobs/{id}/events",
          tags: ["Jobs"],
          summary: "Follow one job (Server-Sent Events)",
          description:
            "Sends the current state, then each change (queued → submitted → in block → finalized | failed), then closes.",
          security: authenticated,
          middleware: [requireScope("jobs", "read")] as const,
          request: { params: IdParam },
          responses: {
            200: { description: "Event stream of Job", content: sse },
            ...errorResponses,
          },
        }),
        async (c) => {
          const accountId = accountOf(c);
          const { id } = c.req.valid("param");
          await loadJob(accountId, id);
          return stream(
            c,
            (push) => services.jobEvents.subscribeJob(id, push),
            async () => [jobEventOf(await loadJob(accountId, id))],
            (event) => TERMINAL.has(event.status),
          );
        },
      )
  );
}
