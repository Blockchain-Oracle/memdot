"use client";

import { MAX_PAGE_SIZE } from "@memdot/config";
import { formatTpot, type RequestLogEntry } from "@memdot/sdk";
import { Button } from "@memdot/ui/components/button";
import { CidText } from "@memdot/ui/components/cid-text";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@memdot/ui/components/empty";
import { Input } from "@memdot/ui/components/input";
import { SegmentedControl } from "@memdot/ui/components/segmented-control";
import { Skeleton } from "@memdot/ui/components/skeleton";
import { Spinner } from "@memdot/ui/components/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@memdot/ui/components/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@memdot/ui/components/tooltip";
import { cn } from "@memdot/ui/lib/utils";
import { useInfiniteQuery } from "@tanstack/react-query";
import { SearchIcon } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Page, PageHeader } from "@/components/page-header";
import { Stat, StatRow } from "@/components/stat";
import { describeError } from "@/lib/errors";
import { formatDualTime, formatNumber, formatRelative } from "@/lib/format";
import { useMemDot } from "@/lib/memdot";

const LIVE_MS = 5_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const STATUS_FILTERS = [
  { value: "all", label: "All" },
  { value: "2", label: "2xx" },
  { value: "4", label: "4xx" },
  { value: "5", label: "5xx" },
];

function statusTone(status: number) {
  if (status >= 500) return "bg-danger";
  if (status >= 400) return "bg-warn";
  return "bg-ok";
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function When({ at }: { at: string }) {
  const time = formatDualTime(at);
  return (
    <Tooltip>
      <TooltipTrigger className="text-ui-sm whitespace-nowrap text-text-3">
        {formatRelative(at)}
      </TooltipTrigger>
      <TooltipContent className="font-mono text-[12px]">
        {time.local} · {time.utc}
      </TooltipContent>
    </Tooltip>
  );
}

export default function ActivityPage() {
  return (
    <Page>
      <PageHeader
        title="Activity"
        description="API requests (method, path, status and timing; never contents) and every transaction on Portaldot for your data."
      />
      <Tabs defaultValue="requests" className="gap-6">
        <TabsList>
          <TabsTrigger value="requests">Requests</TabsTrigger>
          <TabsTrigger value="chain">Chain transactions</TabsTrigger>
        </TabsList>
        <TabsContent value="requests">
          <Requests />
        </TabsContent>
        <TabsContent value="chain">
          <Transactions />
        </TabsContent>
      </Tabs>
    </Page>
  );
}

function Requests() {
  const memdot = useMemDot();
  const [status, setStatus] = useState("all");
  const [search, setSearch] = useState("");
  const [live, setLive] = useState(true);
  const requests = useInfiniteQuery({
    queryKey: ["activity", "requests"],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      memdot.activity.requests({
        limit: MAX_PAGE_SIZE,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: live ? LIVE_MS : false,
  });

  const all = useMemo(() => requests.data?.pages.flatMap((p) => p.items) ?? [], [requests.data]);
  const day = all.filter((r) => Date.now() - new Date(r.createdAt).getTime() < DAY_MS);
  const ok = day.filter((r) => r.status < 400).length;
  const shown = all.filter(
    (r: RequestLogEntry) =>
      (status === "all" || String(r.status).startsWith(status)) &&
      (!search || r.path.toLowerCase().includes(search.toLowerCase())),
  );

  return (
    <div className="flex flex-col gap-6">
      <StatRow>
        <Stat
          label="Requests · 24h"
          value={requests.data ? day.length : undefined}
          hint={all.length >= MAX_PAGE_SIZE ? "Of the latest loaded" : undefined}
        />
        <Stat
          label="Success rate"
          value={
            requests.data
              ? day.length
                ? Math.round((ok / day.length) * 1000) / 10
                : 100
              : undefined
          }
          format={(n) => `${n}%`}
          hint="Below 400"
        />
        <Stat
          label="p50 latency"
          value={requests.data ? median(day.map((r) => r.latencyMs)) : undefined}
          format={(n) => `${n} ms`}
        />
        <Stat
          label="From API keys"
          value={requests.data ? day.filter((r) => r.apiKeyPrefix).length : undefined}
          hint="The rest from dashboard sessions"
        />
      </StatRow>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full sm:w-64">
          <SearchIcon className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-text-4" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter by path"
            aria-label="Filter by path"
            className="pl-8 font-mono"
          />
        </div>
        <SegmentedControl
          label="Status"
          options={STATUS_FILTERS}
          value={status}
          onValueChange={setStatus}
        />
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto gap-2 text-text-2"
          onClick={() => setLive((l) => !l)}
        >
          <span
            className={cn("size-1.5 rounded-full", live ? "animate-pulse bg-ember" : "bg-text-4")}
          />
          {live ? "Live" : "Paused"}
        </Button>
      </div>

      {requests.isPending ? (
        <Skeleton className="h-64 w-full rounded-xl" />
      ) : requests.isError ? (
        <p className="rounded-xl border border-danger/30 bg-danger/10 p-4 text-ui-sm text-danger-fg">
          {describeError(requests.error).title}
        </p>
      ) : shown.length === 0 ? (
        <Empty className="rounded-xl border border-dashed border-border-strong py-12">
          <EmptyHeader>
            <EmptyTitle>No requests match</EmptyTitle>
            <EmptyDescription className="font-mono text-ui-sm">
              curl -H "Authorization: Bearer $MEMDOT_API_KEY" …/v1/spaces
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-surface-1">
          <table className="w-full min-w-[760px] text-left">
            <thead>
              <tr className="border-b border-border font-mono text-label text-text-3 uppercase">
                <th className="px-4 py-2.5 font-medium">Time</th>
                <th className="px-4 py-2.5 font-medium">Method</th>
                <th className="px-4 py-2.5 font-medium">Path</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 text-right font-medium">Latency</th>
                <th className="px-4 py-2.5 font-medium">Caller</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className="border-b border-border last:border-0 hover:bg-surface-2">
                  <td className="px-4 py-2">
                    <When at={r.createdAt} />
                  </td>
                  <td className="px-4 py-2">
                    <span className="rounded-sm border border-border px-1.5 py-0.5 font-mono text-[11px] text-text-2">
                      {r.method}
                    </span>
                  </td>
                  <td
                    className="max-w-[340px] truncate px-4 py-2 font-mono text-mono text-text-2"
                    title={r.path}
                  >
                    {r.path}
                  </td>
                  <td className="px-4 py-2">
                    <span className="inline-flex items-center gap-1.5 font-mono text-mono tabular">
                      <span className={cn("size-1.5 rounded-full", statusTone(r.status))} />
                      {r.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-mono text-text-2 tabular">
                    {r.latencyMs} ms
                  </td>
                  <td className="px-4 py-2 text-ui-sm text-text-3">
                    {r.apiKeyPrefix ? (
                      <span className="font-mono">{r.apiKeyPrefix}…</span>
                    ) : (
                      (r.client ?? "session")
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {requests.hasNextPage && (
        <Button
          variant="ghost"
          className="self-center"
          onClick={() => requests.fetchNextPage()}
          disabled={requests.isFetchingNextPage}
        >
          {requests.isFetchingNextPage && <Spinner data-icon="inline-start" />}
          Load older
        </Button>
      )}
    </div>
  );
}

function Transactions() {
  const memdot = useMemDot();
  const txs = useInfiniteQuery({
    queryKey: ["activity", "transactions"],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      memdot.activity.transactions({
        limit: MAX_PAGE_SIZE,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const all = txs.data?.pages.flatMap((p) => p.items) ?? [];
  const spent = all.reduce((sum, t) => sum + BigInt(t.feePlanck ?? 0), 0n);

  if (txs.isPending) return <Skeleton className="h-64 w-full rounded-xl" />;
  if (txs.isError) {
    return (
      <p className="rounded-xl border border-danger/30 bg-danger/10 p-4 text-ui-sm text-danger-fg">
        {describeError(txs.error).title}
      </p>
    );
  }
  if (all.length === 0) {
    return (
      <Empty className="rounded-xl border border-dashed border-border-strong py-12">
        <EmptyHeader>
          <EmptyTitle>No transactions yet</EmptyTitle>
          <EmptyDescription>
            Each store and renewal of your data shows up here with its block and hash.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <p className="text-ui-sm text-text-3">
        {formatNumber(all.length)} transactions loaded ·{" "}
        <span className="font-mono">{formatTpot(spent)}</span> in fees, paid by MemDot
      </p>
      <div className="overflow-x-auto rounded-xl border border-border bg-surface-1">
        <table className="w-full min-w-[760px] text-left">
          <thead>
            <tr className="border-b border-border font-mono text-label text-text-3 uppercase">
              <th className="px-4 py-2.5 font-medium">Time</th>
              <th className="px-4 py-2.5 font-medium">Type</th>
              <th className="px-4 py-2.5 font-medium">Transaction</th>
              <th className="px-4 py-2.5 font-medium">CID</th>
              <th className="px-4 py-2.5 font-medium">Block</th>
              <th className="px-4 py-2.5 text-right font-medium">Fee</th>
            </tr>
          </thead>
          <tbody>
            {all.map((t) => (
              <tr key={t.id} className="border-b border-border last:border-0 hover:bg-surface-2">
                <td className="px-4 py-2">
                  <When at={t.at} />
                </td>
                <td className="px-4 py-2 text-ui">{t.type === "store" ? "Store" : "Renew"}</td>
                <td className="px-4 py-2">
                  <CidText value={t.txHash} href={`/proof/tx/${t.txHash}`} />
                </td>
                <td className="px-4 py-2">
                  <CidText value={t.cid} href={`/proof/cid/${t.cid}`} />
                </td>
                <td className="px-4 py-2">
                  <Link
                    href={`/proof/block/${t.block}`}
                    className="font-mono text-mono tabular underline-offset-4 hover:underline"
                  >
                    #{formatNumber(t.block)}
                  </Link>
                </td>
                <td className="px-4 py-2 text-right font-mono text-mono text-text-2 tabular">
                  {t.feePlanck ? formatTpot(BigInt(t.feePlanck)) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {txs.hasNextPage && (
        <Button
          variant="ghost"
          className="self-center"
          onClick={() => txs.fetchNextPage()}
          disabled={txs.isFetchingNextPage}
        >
          {txs.isFetchingNextPage && <Spinner data-icon="inline-start" />}
          Load older
        </Button>
      )}
    </div>
  );
}
