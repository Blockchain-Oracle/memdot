"use client";

import { Button } from "@memdot/ui/components/button";
import { ChainProgress } from "@memdot/ui/components/chain-progress";
import { Skeleton } from "@memdot/ui/components/skeleton";
import { cn } from "@memdot/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { ArrowRightIcon, CheckIcon, ChevronRightIcon } from "lucide-react";
import Link from "next/link";
import { Page, PageHeader } from "@/components/page-header";
import { JOB_LABEL } from "@/components/shell/tx-tray";
import { Stat, StatRow } from "@/components/stat";
import {
  formatBytes,
  formatNumber,
  formatRelative,
  planckToTpot,
  TPOT_SHOWN_DIGITS,
} from "@/lib/format";
import { useMemDot } from "@/lib/memdot";
import { useRecentJobs, useSpaces, useUsage } from "@/lib/queries";
import { blocksToDuration } from "@/lib/time";

const RECENT = 5;

export default function OverviewPage() {
  const memdot = useMemDot();
  const usage = useUsage();
  const spaces = useSpaces();
  const jobs = useRecentJobs();
  const keys = useQuery({ queryKey: ["keys"], queryFn: () => memdot.keys.list() });
  const given = useQuery({
    queryKey: ["grants", "given"],
    queryFn: () => memdot.sharing.list("given"),
  });
  const unlock = useQuery({
    queryKey: ["unlock-methods"],
    queryFn: () => memdot.account.unlockMethods(),
  });

  const firstSpace = spaces.data?.[0];
  const steps = [
    {
      title: "Create a space",
      done: (spaces.data?.length ?? 0) > 0,
      href: "/files",
      action: "Create",
    },
    {
      title: "Store a file on Portaldot",
      done: (usage.data?.storedBytes ?? 0) > 0,
      href: firstSpace ? `/spaces/${firstSpace.id}?upload=1` : "/files",
      action: "Upload",
    },
    {
      title: "Create an API key",
      done: (keys.data?.items.length ?? 0) > 0,
      href: "/keys?new=1",
      action: "Create",
    },
    {
      title: "Share a space with someone",
      done: (given.data?.items.length ?? 0) > 0,
      href: firstSpace ? `/spaces/${firstSpace.id}?share=1` : "/files",
      action: "Share",
    },
    {
      title: "Unlock with one touch (passkey or wallet)",
      done: unlock.data?.some((m) => m.kind !== "recovery") ?? false,
      href: "/settings#security",
      action: "Set up",
    },
  ];
  const loaded = [spaces, usage, keys, given, unlock].every((q) => q.isSuccess);
  const done = steps.filter((s) => s.done).length;

  const u = usage.data;
  const untilRenewal = u?.nextRenewalBlock && u.headBlock ? u.nextRenewalBlock - u.headBlock : null;

  return (
    <Page>
      <PageHeader
        title="Overview"
        description="Everything here is encrypted on this device and stored on Portaldot V3."
      />

      {loaded && done < steps.length && (
        <section className="overflow-hidden rounded-xl border border-border bg-surface-1">
          <div className="flex items-center justify-between gap-4 border-b border-border px-4 py-3">
            <div className="flex flex-col gap-0.5">
              <h2 className="text-h3">Get started</h2>
              <p className="text-ui-sm text-text-3">
                {done} of {steps.length} done
              </p>
            </div>
            <div className="flex w-32 gap-1" aria-hidden="true">
              {steps.map((s) => (
                <span
                  key={s.title}
                  className={cn("h-1 flex-1 rounded-full", s.done ? "bg-foreground" : "bg-border")}
                />
              ))}
            </div>
          </div>
          <ul>
            {steps.map((s) => (
              <li
                key={s.title}
                className="flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-0"
              >
                <span
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded-full border",
                    s.done ? "border-transparent bg-surface-3" : "border-border-strong",
                  )}
                >
                  {s.done && <CheckIcon className="size-3" aria-hidden="true" />}
                </span>
                <span className={cn("flex-1 text-ui", s.done && "text-text-3 line-through")}>
                  {s.title}
                </span>
                {!s.done && (
                  <Button asChild variant="ghost" size="sm">
                    <Link href={s.href}>
                      {s.action} <ChevronRightIcon data-icon="inline-end" />
                    </Link>
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <StatRow>
        <Stat
          label="Stored"
          value={u?.storedBytes}
          format={formatBytes}
          hint={u ? `${formatNumber(u.blobs.stored)} blobs on chain` : undefined}
        />
        <Stat
          label="In flight"
          value={u?.blobs.pending}
          hint={u?.blobs.lost ? `${u.blobs.lost} lost` : "Waiting for a block"}
        />
        <Stat
          label="Renewals"
          value={u?.renewals}
          hint={untilRenewal !== null ? `Next in ${blocksToDuration(untilRenewal)}` : "None due"}
        />
        <Stat
          label="tPOT spent"
          value={u ? planckToTpot(u.spentPlanck) : undefined}
          format={(n) => n.toFixed(TPOT_SHOWN_DIGITS)}
          hint="Stores and renewals, paid by MemDot"
        />
      </StatRow>

      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-h3">Spaces</h2>
            <Link href="/files" className="text-ui-sm text-text-3 hover:text-foreground">
              Open files
            </Link>
          </div>
          {spaces.isPending ? (
            <Skeleton className="h-24 w-full rounded-xl" />
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2">
              {spaces.data?.map((space) => {
                const ratio = space.quotaBytes ? space.usedBytes / space.quotaBytes : 0;
                return (
                  <li key={space.id}>
                    <Link
                      href={`/spaces/${space.id}`}
                      className="group flex flex-col gap-3 rounded-xl border border-border bg-surface-1 p-4 shadow-card transition-colors duration-(--motion-instant) hover:border-border-strong"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="truncate text-ui font-medium">
                          {space.name ?? "Encrypted space"}
                        </span>
                        <ArrowRightIcon className="size-4 text-text-4 transition-colors group-hover:text-foreground" />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <span className="h-1 overflow-hidden rounded-full bg-border">
                          <span
                            className={cn(
                              "block h-full rounded-full",
                              ratio >= 0.8 ? "bg-warn" : "bg-foreground",
                            )}
                            style={{ width: `${Math.max(ratio * 100, 1)}%` }}
                          />
                        </span>
                        <span className="font-mono text-ui-sm text-text-3 tabular">
                          {formatBytes(space.usedBytes)} of {formatBytes(space.quotaBytes)} ·{" "}
                          {space.mode === "sponsored" ? "sponsored" : "self-signed"}
                        </span>
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <h2 className="text-h3">Chain activity</h2>
            <Link href="/activity" className="text-ui-sm text-text-3 hover:text-foreground">
              All activity
            </Link>
          </div>
          <div className="overflow-hidden rounded-xl border border-border bg-surface-1">
            {jobs.isPending ? (
              <Skeleton className="m-3 h-16" />
            ) : jobs.data?.items.length ? (
              <ul>
                {jobs.data.items.slice(0, RECENT).map((job) => (
                  <li
                    key={job.id}
                    className="flex flex-col gap-1 border-b border-border px-4 py-2.5 last:border-0"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-ui">{JOB_LABEL[job.kind] ?? job.kind}</span>
                      <span className="text-ui-sm text-text-3">
                        {formatRelative(job.updatedAt)}
                      </span>
                    </div>
                    <ChainProgress stage={job.status} block={job.block} progress={job.progress} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-4 py-8 text-center text-ui-sm text-text-3">
                Stores and renewals appear here as they reach the chain.
              </p>
            )}
          </div>
        </section>
      </div>
    </Page>
  );
}
