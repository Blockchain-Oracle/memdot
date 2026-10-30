"use client";

import { BLOCK_MS, MAX_PAGE_SIZE, RENEW_AT_FRACTION, RETENTION_BLOCKS } from "@memdot/config";
import type { ListedFile } from "@memdot/sdk";
import { Button } from "@memdot/ui/components/button";
import { CidText } from "@memdot/ui/components/cid-text";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@memdot/ui/components/empty";
import { RetentionMeter } from "@memdot/ui/components/retention-meter";
import { Skeleton } from "@memdot/ui/components/skeleton";
import { Spinner } from "@memdot/ui/components/spinner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCwIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { FileStatus } from "@/components/files/file-table";
import { Page, PageHeader } from "@/components/page-header";
import { Stat, StatRow } from "@/components/stat";
import { describeError } from "@/lib/errors";
import { formatNumber, formatRelative } from "@/lib/format";
import { useMemDot } from "@/lib/memdot";
import { useSpaces, useUsage } from "@/lib/queries";
import { retentionOf } from "@/lib/retention";
import { blocksToDuration } from "@/lib/time";

const SHOWN = 25;
const DAY_MS = 24 * 60 * 60 * 1000;
const RENEW_AFTER_DAYS = ((RETENTION_BLOCKS * RENEW_AT_FRACTION * BLOCK_MS) / DAY_MS).toFixed(1);

export default function RenewalsPage() {
  const memdot = useMemDot();
  const queryClient = useQueryClient();
  const usage = useUsage();
  const { data: spaces } = useSpaces();
  const files = useQuery({
    queryKey: ["files", "all", "expiring"],
    queryFn: () => memdot.files.list({ limit: MAX_PAGE_SIZE }),
  });
  const txs = useQuery({
    queryKey: ["activity", "transactions", "first"],
    queryFn: () => memdot.activity.transactions({ limit: MAX_PAGE_SIZE }),
  });
  const [renewing, setRenewing] = useState<string | null>(null);
  const renew = useMutation({
    mutationFn: (file: ListedFile) => {
      setRenewing(file.id);
      return memdot.files.renew(file.id);
    },
    onSuccess: async (job) => {
      toast.success(`Renewed in block #${job.block ? formatNumber(job.block) : "?"}.`);
      await queryClient.invalidateQueries({ queryKey: ["files"] });
      await queryClient.invalidateQueries({ queryKey: ["activity"] });
    },
    onError: (error) => toast.error(describeError(error).title),
    onSettled: () => setRenewing(null),
  });

  const u = usage.data;
  const head = files.data?.headBlock ?? u?.headBlock ?? null;
  const soonest = [...(files.data?.items ?? [])]
    .filter((f) => f.status === "stored" || f.status === "lost")
    .sort(
      (a, b) =>
        (a.expiresAtBlock ?? Number.POSITIVE_INFINITY) -
        (b.expiresAtBlock ?? Number.POSITIVE_INFINITY),
    )
    .slice(0, SHOWN);
  const renewals = txs.data?.items.filter((t) => t.type === "renew") ?? [];
  const untilNext = u?.nextRenewalBlock && head ? u.nextRenewalBlock - head : null;
  const spaceName = (id: string | null) => spaces?.find((s) => s.id === id)?.name ?? "—";

  return (
    <Page>
      <PageHeader
        title="Renewals"
        description="Portaldot keeps stored bytes for 7 days. MemDot's keeper renews everything before then, same CID, paid by MemDot."
      />

      <StatRow>
        <Stat
          label="Blobs kept alive"
          value={u?.blobs.stored}
          hint={u?.blobs.lost ? `${u.blobs.lost} lost` : "None lost"}
        />
        <Stat label="Renewals so far" value={u?.renewals} />
        <Stat
          label="Next renewal"
          value={untilNext !== null ? Math.max(0, untilNext) : u ? 0 : undefined}
          format={(n) => (untilNext === null ? "—" : blocksToDuration(n))}
          hint={u?.nextRenewalBlock ? `Block #${formatNumber(u.nextRenewalBlock)}` : "Nothing due"}
        />
        <Stat
          label="Expired, still served"
          value={u?.blobs.expiredServed}
          hint="Re-stored from MemDot's cache"
        />
      </StatRow>

      <section className="grid gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-3">
        {[
          ["Window", `${formatNumber(RETENTION_BLOCKS)} blocks · 7 days`],
          ["Keeper renews at", `${Math.round(RENEW_AT_FRACTION * 100)}% · day ${RENEW_AFTER_DAYS}`],
          ["Head block", head !== null ? `#${formatNumber(head)}` : "—"],
        ].map(([label, value]) => (
          <div key={label} className="flex flex-col gap-1 bg-surface-1 p-4">
            <span className="eyebrow">{label}</span>
            <span className="font-mono text-mono text-foreground tabular">{value}</span>
          </div>
        ))}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-h3">Expiring soonest</h2>
        {files.isPending ? (
          <Skeleton className="h-48 w-full rounded-xl" />
        ) : soonest.length === 0 ? (
          <Empty className="rounded-xl border border-dashed border-border-strong py-10">
            <EmptyHeader>
              <EmptyTitle>Nothing stored yet</EmptyTitle>
              <EmptyDescription>
                Files appear here with the time left in their window.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border bg-surface-1">
            <table className="w-full min-w-[720px] text-left">
              <thead>
                <tr className="border-b border-border font-mono text-label text-text-3 uppercase">
                  <th className="px-4 py-2.5 font-medium">File</th>
                  <th className="px-4 py-2.5 font-medium">Space</th>
                  <th className="px-4 py-2.5 font-medium">Window</th>
                  <th className="px-4 py-2.5 font-medium">Expires</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody>
                {soonest.map((file) => {
                  const retention = retentionOf(file.expiresAtBlock, head, file.status === "lost");
                  return (
                    <tr key={file.id} className="border-b border-border last:border-0">
                      <td className="max-w-[240px] truncate px-4 py-2.5 text-ui">
                        <Link href={`/spaces/${file.spaceId}`} className="hover:underline">
                          {file.name ?? "Encrypted file"}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5 text-ui-sm text-text-2">
                        {spaceName(file.spaceId)}
                      </td>
                      <td className="px-4 py-2.5">
                        <RetentionMeter remaining={retention.remaining} state={retention.state} />
                      </td>
                      <td className="px-4 py-2.5 font-mono text-ui-sm text-text-2 tabular">
                        {file.expiresAtBlock ? `#${formatNumber(file.expiresAtBlock)}` : "—"}
                        {retention.blocksLeft !== null && retention.blocksLeft > 0 && (
                          <span className="text-text-3">
                            {" "}
                            · {blocksToDuration(retention.blocksLeft)}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <FileStatus file={file} retention={retention} />
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => renew.mutate(file)}
                          disabled={renewing !== null}
                        >
                          {renewing === file.id ? (
                            <Spinner data-icon="inline-start" />
                          ) : (
                            <RefreshCwIcon data-icon="inline-start" />
                          )}
                          Renew now
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-h3">Recent renewals</h2>
        {txs.isPending ? (
          <Skeleton className="h-24 w-full rounded-xl" />
        ) : renewals.length === 0 ? (
          <p className="rounded-xl border border-border bg-surface-1 p-4 text-ui-sm text-text-3">
            No renewals yet. The first comes about {RENEW_AFTER_DAYS} days after a store.
          </p>
        ) : (
          <ul className="overflow-hidden rounded-xl border border-border bg-surface-1">
            {renewals.slice(0, SHOWN).map((t) => (
              <li
                key={t.id}
                className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-4 py-2.5 last:border-0"
              >
                <CidText value={t.cid} href={`/proof/cid/${t.cid}`} />
                <Link
                  href={`/proof/block/${t.block}`}
                  className="font-mono text-ui-sm text-text-2 tabular hover:underline"
                >
                  #{formatNumber(t.block)}
                </Link>
                <span className="ml-auto text-ui-sm text-text-3">{formatRelative(t.at)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Page>
  );
}
