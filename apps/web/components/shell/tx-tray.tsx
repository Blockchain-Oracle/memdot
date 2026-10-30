"use client";

import type { Job } from "@memdot/sdk";
import { Button } from "@memdot/ui/components/button";
import { ChainProgress, ChainProgressGlyph } from "@memdot/ui/components/chain-progress";
import { Popover, PopoverContent, PopoverTrigger } from "@memdot/ui/components/popover";
import Link from "next/link";
import { formatRelative } from "@/lib/format";
import { TERMINAL, useRecentJobs } from "@/lib/queries";

const SHOWN = 6;

export const JOB_LABEL: Record<string, string> = {
  store_object: "Store",
  renew: "Renew",
  restore: "Restore",
};

/** The top-bar chip: in-flight chain transactions as the mark glyph, with their stages. */
export function TxTray() {
  const { data } = useRecentJobs();
  const jobs = data?.items ?? [];
  const active = jobs.filter((job) => !TERMINAL.has(job.status));
  const shown = (active.length > 0 ? active : jobs).slice(0, SHOWN);
  const lead: Job["status"] = active[0]?.status ?? jobs[0]?.status ?? "finalized";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="gap-2 text-text-2"
          aria-label="Chain transactions"
        >
          <ChainProgressGlyph stage={active.length > 0 ? lead : "finalized"} />
          <span className="hidden font-mono tabular sm:inline">
            {active.length > 0 ? `${active.length} pending` : "Synced"}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
          <span className="eyebrow">Chain transactions</span>
          <Link href="/activity" className="text-ui-sm text-text-3 hover:text-foreground">
            All activity
          </Link>
        </div>
        {shown.length === 0 ? (
          <p className="px-3 py-6 text-center text-ui-sm text-text-3">
            Nothing yet. Stores and renewals show up here as they go on chain.
          </p>
        ) : (
          <ul className="flex flex-col">
            {shown.map((job) => (
              <li
                key={job.id}
                className="flex flex-col gap-1 border-b border-border px-3 py-2.5 last:border-0"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-ui">{JOB_LABEL[job.kind] ?? job.kind}</span>
                  <span className="text-ui-sm text-text-3">{formatRelative(job.updatedAt)}</span>
                </div>
                <ChainProgress
                  stage={job.status}
                  block={job.block}
                  progress={job.progress}
                  error={job.error}
                />
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
