"use client";

import { MAX_SPACES_PER_ACCOUNT, SPONSORED_QUOTA_BYTES } from "@memdot/config";
import { formatTpot } from "@memdot/sdk";
import {
  PartitionBar,
  PartitionBarSegment,
  PartitionBarSegmentTitle,
  PartitionBarSegmentValue,
} from "@memdot/ui/components/partition-bar";
import { Skeleton } from "@memdot/ui/components/skeleton";
import { cn } from "@memdot/ui/lib/utils";
import { CheckIcon } from "lucide-react";
import Link from "next/link";
import { Page, PageHeader } from "@/components/page-header";
import { Stat, StatRow } from "@/components/stat";
import { formatBytes, formatNumber, planckToTpot, TPOT_SHOWN_DIGITS } from "@/lib/format";
import { useSpaces, useUsage } from "@/lib/queries";

const VARIANTS = ["default", "secondary", "muted"] as const;

export default function UsagePage() {
  const usage = useUsage();
  const { data: spaces, isPending } = useSpaces();
  const u = usage.data;
  const sponsored = spaces?.filter((s) => s.mode === "sponsored") ?? [];
  const quota = sponsored.reduce((sum, s) => sum + s.quotaBytes, 0);
  const used = sponsored.reduce((sum, s) => sum + s.usedBytes, 0);

  return (
    <Page>
      <PageHeader
        title="Plans & usage"
        description="Quotas only, no payments. Sponsored spaces are stored and renewed at MemDot's cost."
      />

      <StatRow>
        <Stat
          label="Stored"
          value={u?.storedBytes}
          format={formatBytes}
          hint={
            u ? `${formatNumber(u.blobs.stored)} blob${u.blobs.stored === 1 ? "" : "s"}` : undefined
          }
        />
        <Stat label="Spaces" value={spaces?.length} hint={`Up to ${MAX_SPACES_PER_ACCOUNT}`} />
        <Stat
          label="Sponsored quota used"
          value={spaces ? used : undefined}
          format={formatBytes}
          hint={`of ${formatBytes(quota)}`}
        />
        <Stat
          label="Sponsored by MemDot"
          value={u ? planckToTpot(u.spentPlanck) : undefined}
          format={(n) => `${n.toFixed(TPOT_SHOWN_DIGITS)}`}
          hint="tPOT for stores and renewals"
        />
      </StatRow>

      <section className="grid gap-4 md:grid-cols-2">
        {[
          {
            name: "Sponsored",
            active: sponsored.length > 0,
            facts: [
              `${formatBytes(SPONSORED_QUOTA_BYTES)} per space, up to ${MAX_SPACES_PER_ACCOUNT} spaces`,
              "MemDot's relayer stores, the keeper renews",
              "Fees are on MemDot",
              "Encrypted on your device, same as always",
            ],
          },
          {
            name: "Self-signed",
            active: (spaces?.length ?? 0) > sponsored.length,
            facts: [
              "Your wallet signs every store",
              "Your wallet pays the fee in tPOT",
              "No MemDot quota",
              "MemDot still indexes, renews and serves",
            ],
          },
        ].map((plan) => (
          <div
            key={plan.name}
            className={cn(
              "flex flex-col gap-3 rounded-xl border bg-surface-1 p-5 shadow-card",
              plan.active ? "border-border-strong" : "border-border",
            )}
          >
            <div className="flex items-center justify-between">
              <h2 className="text-h3">{plan.name}</h2>
              {plan.active && <span className="eyebrow">In use</span>}
            </div>
            <ul className="flex flex-col gap-2">
              {plan.facts.map((fact) => (
                <li key={fact} className="flex items-start gap-2 text-ui-sm text-text-2">
                  <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-text-3" aria-hidden="true" />{" "}
                  {fact}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-h3">Sponsored quota by space</h2>
        {isPending ? (
          <Skeleton className="h-16 w-full" />
        ) : quota > 0 ? (
          <div className="rounded-xl border border-border bg-surface-1 p-5">
            <PartitionBar size="sm" gap={0.5}>
              {[
                ...sponsored
                  .filter((s) => s.usedBytes > 0)
                  .map((s, i) => (
                    <PartitionBarSegment
                      key={s.id}
                      num={s.usedBytes}
                      variant={VARIANTS[i % VARIANTS.length]}
                      alignment="left"
                    >
                      <PartitionBarSegmentTitle>{s.name ?? "Space"}</PartitionBarSegmentTitle>
                      <PartitionBarSegmentValue>
                        {formatBytes(s.usedBytes)}
                      </PartitionBarSegmentValue>
                    </PartitionBarSegment>
                  )),
                <PartitionBarSegment
                  key="free"
                  num={Math.max(quota - used, 0)}
                  variant="outline"
                  alignment="right"
                >
                  <PartitionBarSegmentTitle>Free</PartitionBarSegmentTitle>
                  <PartitionBarSegmentValue>
                    {formatBytes(Math.max(quota - used, 0))}
                  </PartitionBarSegmentValue>
                </PartitionBarSegment>,
              ]}
            </PartitionBar>
          </div>
        ) : (
          <p className="text-ui-sm text-text-3">No sponsored spaces yet.</p>
        )}
        <ul className="overflow-hidden rounded-xl border border-border bg-surface-1">
          {spaces?.map((space) => {
            const ratio = space.quotaBytes ? space.usedBytes / space.quotaBytes : 0;
            return (
              <li
                key={space.id}
                className="flex flex-col gap-2 border-b border-border px-4 py-3 last:border-0"
              >
                <div className="flex items-center justify-between gap-3">
                  <Link href={`/spaces/${space.id}`} className="truncate text-ui hover:underline">
                    {space.name ?? "Encrypted space"}
                  </Link>
                  <span className="shrink-0 font-mono text-ui-sm text-text-2 tabular">
                    {formatBytes(space.usedBytes)} / {formatBytes(space.quotaBytes)} ·{" "}
                    {Math.round(ratio * 100)}%
                  </span>
                </div>
                <span className="h-1 overflow-hidden rounded-full bg-border">
                  <span
                    className={cn(
                      "block h-full rounded-full",
                      ratio >= 0.8 ? "bg-warn" : "bg-foreground",
                    )}
                    style={{ width: `${Math.max(ratio * 100, 1)}%` }}
                  />
                </span>
              </li>
            );
          })}
        </ul>
        {u && (
          <p className="text-ui-sm text-text-3">
            Spent so far on your data:{" "}
            <span className="font-mono">{formatTpot(BigInt(u.spentPlanck))}</span> ·{" "}
            {formatNumber(u.renewals)} renewals.
          </p>
        )}
      </section>
    </Page>
  );
}
