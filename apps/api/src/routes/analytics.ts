import { createRoute, z } from "@hono/zod-openapi";
import { memories, requestLogs } from "@memdot/db";
import { and, count, desc, eq, gte, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "../db.js";
import { accountOf, requireAccountWide, requireScope } from "../lib/principal.js";
import { authenticated, createRouter, errorResponses, jsonContent } from "../lib/router.js";

/** The request log keeps this long, so asking for more would only look like a quiet start. */
const MAX_DAYS = 30;
const TOP_ROWS = 8;
const DAY_MS = 24 * 60 * 60 * 1000;

const Point = z.object({
  day: z.string(),
  add: z.number().int(),
  search: z.number().int(),
  read: z.number().int(),
  other: z.number().int(),
  errors: z.number().int(),
});

const Named = z.object({ name: z.string(), count: z.number().int() });

const Analytics = z
  .object({
    days: z.number().int(),
    requests: z.number().int(),
    errors: z.number().int(),
    avg_latency_ms: z.number().int(),
    p95_latency_ms: z.number().int(),
    requests_by_day: z.array(Point),
    memories_by_day: z.array(z.object({ day: z.string(), count: z.number().int() })),
    memories: z.object({
      total: z.number().int(),
      assisted: z.number().int(),
      private: z.number().int(),
    }),
    top_users: z.array(Named),
    top_agents: z.array(Named),
    categories: z.array(Named),
    top_clients: z.array(Named),
  })
  .openapi("Analytics");

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

/** Every day in the range, so a quiet day is a zero on the chart rather than a gap. */
function everyDay(days: number): string[] {
  const today = Date.now();
  return Array.from({ length: days }, (_, i) => isoDay(new Date(today - (days - 1 - i) * DAY_MS)));
}

export function analyticsRoutes() {
  return createRouter().openapi(
    createRoute({
      method: "get",
      path: "/v1/analytics",
      tags: ["Usage"],
      summary: "How your memories are used",
      description:
        "From request metadata and the server's index, never from what a memory says. Private memories are counted, but who they're about and how they're filed stay on your device, so they're not in the top lists.",
      security: authenticated,
      middleware: [requireScope("usage", "read"), requireAccountWide] as const,
      request: {
        query: z.object({ days: z.coerce.number().int().min(1).max(MAX_DAYS).default(7) }),
      },
      responses: {
        200: { description: "Analytics", content: jsonContent(Analytics) },
        ...errorResponses,
      },
    }),
    async (c) => {
      const accountId = accountOf(c);
      const { days } = c.req.valid("query");
      const since = new Date(Date.now() - days * DAY_MS);
      const inRange = and(eq(requestLogs.accountId, accountId), gte(requestLogs.createdAt, since));
      const day = sql<string>`to_char(${requestLogs.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
      const isMemories = sql`${requestLogs.path} like '/v1/memories%'`;
      const isSearch = sql`${requestLogs.path} = '/v1/memories/search'`;

      const [totals] = await db
        .select({
          requests: count(),
          errors: sql<number>`count(*) filter (where ${requestLogs.status} >= 400)::int`,
          average: sql<number>`coalesce(avg(${requestLogs.latencyMs}), 0)::int`,
          p95: sql<number>`coalesce(percentile_cont(0.95) within group (order by ${requestLogs.latencyMs}), 0)::int`,
        })
        .from(requestLogs)
        .where(inRange);

      const byDay = await db
        .select({
          day,
          add: sql<number>`count(*) filter (where ${requestLogs.method} = 'POST' and ${requestLogs.path} = '/v1/memories')::int`,
          search: sql<number>`count(*) filter (where ${isSearch})::int`,
          read: sql<number>`count(*) filter (where ${isMemories} and not ${isSearch} and ${requestLogs.method} in ('GET') or ${requestLogs.path} = '/v1/memories/list')::int`,
          total: count(),
          errors: sql<number>`count(*) filter (where ${requestLogs.status} >= 400)::int`,
        })
        .from(requestLogs)
        .where(inRange)
        .groupBy(day);
      const requestDays = new Map(byDay.map((row) => [row.day, row]));

      const clients = await db
        .select({ name: sql<string>`coalesce(${requestLogs.client}, 'unknown')`, count: count() })
        .from(requestLogs)
        .where(inRange)
        .groupBy(requestLogs.client)
        .orderBy(desc(count()))
        .limit(TOP_ROWS);

      const live = and(eq(memories.accountId, accountId), isNull(memories.deletedAt));
      const memoryDay = sql<string>`to_char(${memories.createdAt} at time zone 'UTC', 'YYYY-MM-DD')`;
      const added = await db
        .select({ day: memoryDay, count: count() })
        .from(memories)
        .where(and(live, gte(memories.createdAt, since)))
        .groupBy(memoryDay);
      const addedDays = new Map(added.map((row) => [row.day, row.count]));

      const byMode = await db
        .select({ mode: memories.mode, count: count() })
        .from(memories)
        .where(live)
        .groupBy(memories.mode);
      const modeCount = (mode: "assisted" | "private") =>
        byMode.find((row) => row.mode === mode)?.count ?? 0;

      const top = (column: typeof memories.userId | typeof memories.agentId) =>
        db
          .select({ name: sql<string>`${column}`, count: count() })
          .from(memories)
          .where(and(live, isNotNull(column)))
          .groupBy(column)
          .orderBy(desc(count()))
          .limit(TOP_ROWS);
      const [topUsers, topAgents, categories] = await Promise.all([
        top(memories.userId),
        top(memories.agentId),
        db
          .select({ name: sql<string>`unnest(${memories.categories})`, count: count() })
          .from(memories)
          .where(and(live, isNotNull(memories.categories)))
          .groupBy(sql`1`)
          .orderBy(desc(count()))
          .limit(TOP_ROWS),
      ]);

      const range = everyDay(days);
      return c.json(
        {
          days,
          requests: totals?.requests ?? 0,
          errors: totals?.errors ?? 0,
          avg_latency_ms: totals?.average ?? 0,
          p95_latency_ms: totals?.p95 ?? 0,
          requests_by_day: range.map((date) => {
            const row = requestDays.get(date);
            const known = (row?.add ?? 0) + (row?.search ?? 0) + (row?.read ?? 0);
            return {
              day: date,
              add: row?.add ?? 0,
              search: row?.search ?? 0,
              read: row?.read ?? 0,
              other: Math.max(0, (row?.total ?? 0) - known),
              errors: row?.errors ?? 0,
            };
          }),
          memories_by_day: range.map((date) => ({ day: date, count: addedDays.get(date) ?? 0 })),
          memories: {
            total: modeCount("assisted") + modeCount("private"),
            assisted: modeCount("assisted"),
            private: modeCount("private"),
          },
          top_users: topUsers,
          top_agents: topAgents,
          categories,
          top_clients: clients,
        },
        200,
      );
    },
  );
}
