"use client";

import type { Analytics } from "@memdot/sdk";
import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from "@memdot/ui/components/chart";
import { SegmentedControl } from "@memdot/ui/components/segmented-control";
import { Skeleton } from "@memdot/ui/components/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@memdot/ui/components/table";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Bar, BarChart, CartesianGrid, Rectangle, XAxis, YAxis } from "recharts";
import { Page, PageHeader } from "@/components/page-header";
import { Stat, StatRow } from "@/components/stat";
import { describeError } from "@/lib/errors";
import { formatNumber } from "@/lib/format";
import { useMemDot } from "@/lib/memdot";

const RANGES = [
  { value: "7", label: "7 days" },
  { value: "14", label: "14 days" },
  { value: "30", label: "30 days" },
];
const VIEWS = [
  { value: "chart", label: "Chart" },
  { value: "table", label: "Table" },
];
const MAX_BAR_PX = 24;
const CORNER_PX = 4;
const CHART_HEIGHT = "h-64";

/** Stacked in this order, and each keeps its colour whatever the range shows. */
const KINDS = ["add", "search", "read", "other"] as const;
type Kind = (typeof KINDS)[number];
const REQUESTS: ChartConfig = {
  add: { label: "Add", color: "var(--chart-1)" },
  search: { label: "Search", color: "var(--chart-2)" },
  read: { label: "Read", color: "var(--chart-3)" },
  other: { label: "Other", color: "var(--chart-4)" },
};
const ADDED: ChartConfig = { count: { label: "Memories added", color: "var(--chart-1)" } };

const shortDay = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
const compact = (value: number) =>
  value >= 1000 ? `${Math.round(value / 100) / 10}K` : String(value);

function ChartCard({
  title,
  description,
  view,
  onView,
  children,
  table,
}: {
  title: string;
  description: string;
  view: string;
  onView: (view: string) => void;
  children: React.ReactNode;
  table: React.ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-4 rounded-xl border border-border bg-surface-1 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h2 className="text-h3">{title}</h2>
          <p className="text-ui-sm text-text-3">{description}</p>
        </div>
        <SegmentedControl
          options={VIEWS}
          label={`${title} view`}
          value={view}
          onValueChange={onView}
        />
      </div>
      {view === "chart" ? children : <div className="max-h-64 overflow-auto">{table}</div>}
    </section>
  );
}

function RequestsChart({ data }: { data: Analytics }) {
  const [view, setView] = useState("chart");
  return (
    <ChartCard
      title="Requests"
      description="Every call to the API, by what it did."
      view={view}
      onView={setView}
      table={
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Day</TableHead>
              {KINDS.map((kind) => (
                <TableHead key={kind} className="text-right">
                  {REQUESTS[kind]?.label}
                </TableHead>
              ))}
              <TableHead className="text-right">Failed</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.requests_by_day.map((row) => (
              <TableRow key={row.day}>
                <TableCell>{shortDay(row.day)}</TableCell>
                {KINDS.map((kind) => (
                  <TableCell key={kind} className="text-right font-mono text-ui-sm tabular">
                    {formatNumber(row[kind])}
                  </TableCell>
                ))}
                <TableCell className="text-right font-mono text-ui-sm tabular">
                  {formatNumber(row.errors)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      }
    >
      <ChartContainer config={REQUESTS} className={`${CHART_HEIGHT} w-full`}>
        <BarChart accessibilityLayer data={data.requests_by_day}>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="day"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={24}
            tickFormatter={shortDay}
          />
          <YAxis
            allowDecimals={false}
            tickLine={false}
            axisLine={false}
            width={36}
            tickFormatter={compact}
          />
          <ChartTooltip
            cursor={{ fill: "var(--md-surface-2)" }}
            content={<ChartTooltipContent labelFormatter={(day) => shortDay(String(day))} />}
          />
          <ChartLegend content={<ChartLegendContent />} />
          {KINDS.map((kind, index) => (
            <Bar
              key={kind}
              dataKey={kind}
              stackId="requests"
              maxBarSize={MAX_BAR_PX}
              fill={`var(--color-${kind})`}
              stroke="var(--md-surface-1)"
              strokeWidth={2}
              // Only the top of each day's stack is rounded, whichever kind that happens to be.
              shape={(props: { payload?: Record<Kind, number> }) => {
                const top = KINDS.slice(index + 1).every((above) => !props.payload?.[above]);
                return (
                  <Rectangle
                    {...(props as object)}
                    radius={top ? [CORNER_PX, CORNER_PX, 0, 0] : 0}
                  />
                );
              }}
            />
          ))}
        </BarChart>
      </ChartContainer>
    </ChartCard>
  );
}

function AddedChart({ data }: { data: Analytics }) {
  const [view, setView] = useState("chart");
  return (
    <ChartCard
      title="Memories added"
      description="Assisted and Private together. Private ones are only counted."
      view={view}
      onView={setView}
      table={
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Day</TableHead>
              <TableHead className="text-right">Added</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.memories_by_day.map((row) => (
              <TableRow key={row.day}>
                <TableCell>{shortDay(row.day)}</TableCell>
                <TableCell className="text-right font-mono text-ui-sm tabular">
                  {formatNumber(row.count)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      }
    >
      <ChartContainer config={ADDED} className={`${CHART_HEIGHT} w-full`}>
        <BarChart accessibilityLayer data={data.memories_by_day}>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="day"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            minTickGap={24}
            tickFormatter={shortDay}
          />
          <YAxis
            allowDecimals={false}
            tickLine={false}
            axisLine={false}
            width={36}
            tickFormatter={compact}
          />
          <ChartTooltip
            cursor={{ fill: "var(--md-surface-2)" }}
            content={<ChartTooltipContent labelFormatter={(day) => shortDay(String(day))} />}
          />
          <Bar
            dataKey="count"
            maxBarSize={MAX_BAR_PX}
            fill="var(--color-count)"
            radius={[CORNER_PX, CORNER_PX, 0, 0]}
          />
        </BarChart>
      </ChartContainer>
    </ChartCard>
  );
}

function TopList({
  title,
  rows,
  empty,
}: {
  title: string;
  rows: { name: string; count: number }[];
  empty: string;
}) {
  const most = Math.max(1, ...rows.map((row) => row.count));
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-surface-1 p-4">
      <h2 className="eyebrow">{title}</h2>
      {rows.length === 0 ? (
        <p className="py-4 text-ui-sm text-text-3">{empty}</p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {rows.map((row) => (
            <li key={row.name} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between gap-3">
                <span className="truncate font-mono text-ui-sm">{row.name}</span>
                <span className="shrink-0 font-mono text-ui-sm text-text-2 tabular">
                  {formatNumber(row.count)}
                </span>
              </div>
              <div className="h-1 overflow-hidden rounded-full bg-surface-2">
                <div
                  className="h-full rounded-full bg-chart-1"
                  style={{ width: `${(row.count / most) * 100}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** How the service is being used, from request metadata and counts, never what anything says. */
export default function AnalyticsPage() {
  const memdot = useMemDot();
  const [range, setRange] = useState("30");
  const analytics = useQuery({
    queryKey: ["analytics", range],
    queryFn: () => memdot.activity.analytics({ days: Number(range) }),
  });
  const data = analytics.data;
  const failedShare = data?.requests ? (data.errors / data.requests) * 100 : 0;

  return (
    <Page>
      <PageHeader
        title="Analytics"
        description="How your memories are used. From request metadata and counts, never what they say."
        actions={
          <SegmentedControl
            options={RANGES}
            label="Time range"
            value={range}
            onValueChange={setRange}
          />
        }
      />
      {analytics.error ? (
        <p className="rounded-xl border border-danger/30 bg-danger/10 p-4 text-ui text-danger-fg">
          {describeError(analytics.error).title}
        </p>
      ) : (
        <>
          <StatRow>
            <Stat label="Requests" value={data?.requests} format={formatNumber} />
            <Stat
              label="Failed"
              value={data ? failedShare : undefined}
              format={(value) => `${value.toFixed(1)}%`}
              hint={data ? `${formatNumber(data.errors)} requests` : undefined}
            />
            <Stat
              label="Slowest 5%"
              value={data?.p95_latency_ms}
              format={(value) => `${formatNumber(value)} ms`}
              hint={data ? `${formatNumber(data.avg_latency_ms)} ms on average` : undefined}
            />
            <Stat
              label="Memories kept"
              value={data?.memories.total}
              format={formatNumber}
              hint={
                data
                  ? `${formatNumber(data.memories.assisted)} Assisted, ${formatNumber(data.memories.private)} Private`
                  : undefined
              }
            />
          </StatRow>
          {data ? (
            <>
              <div className="grid gap-4 lg:grid-cols-2">
                <RequestsChart data={data} />
                <AddedChart data={data} />
              </div>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <TopList
                  title="Top users"
                  rows={data.top_users}
                  empty="No Assisted memories name a user yet."
                />
                <TopList
                  title="Top agents"
                  rows={data.top_agents}
                  empty="No Assisted memories name an agent yet."
                />
                <TopList
                  title="Categories"
                  rows={data.categories}
                  empty="No Assisted memories are filed yet."
                />
                <TopList title="Clients" rows={data.top_clients} empty="No requests yet." />
              </div>
              <p className="text-ui-sm text-text-3">
                Request history is kept for 30 days. Private memories never name their users, agents
                or categories to the server, so they're not in these lists.
              </p>
            </>
          ) : (
            <Skeleton className="h-72 w-full rounded-xl" />
          )}
        </>
      )}
    </Page>
  );
}
