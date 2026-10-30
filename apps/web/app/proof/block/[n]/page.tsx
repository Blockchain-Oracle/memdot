"use client";

import { cidFromContentHash, extrinsicHashes, formatTpot, storageEventsAt } from "@memdot/chain";
import { CidText } from "@memdot/ui/components/cid-text";
import { Skeleton } from "@memdot/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { describeError } from "@/lib/errors";
import { formatNumber } from "@/lib/format";
import { useMemDot } from "@/lib/memdot";

/** A block's TransactionStorage activity, read straight from a Portaldot node by this browser. */
export default function BlockProofPage() {
  const memdot = useMemDot();
  const { n } = useParams<{ n: string }>();
  const block = Number(n);
  const events = useQuery({
    queryKey: ["proof", "block", block],
    enabled: Number.isInteger(block) && block >= 0,
    queryFn: async () => {
      const chain = await memdot.chain();
      const [found, hashes] = await Promise.all([
        storageEventsAt(chain, block),
        extrinsicHashes(chain, block),
      ]);
      return found.map((event) => ({
        ...event,
        cid: cidFromContentHash(event.contentHash),
        txHash: event.extrinsicIndex !== null ? (hashes[event.extrinsicIndex] ?? null) : null,
      }));
    },
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

  return (
    <>
      <div className="flex flex-col gap-2">
        <span className="eyebrow">Block</span>
        <h1 className="font-mono text-h1 tabular">
          #{Number.isInteger(block) ? formatNumber(block) : n}
        </h1>
        <p className="text-ui text-text-2">
          Every TransactionStorage store and renewal in this block, read by your browser from a
          Portaldot node.
        </p>
      </div>
      {events.isPending ? (
        <Skeleton className="h-40 w-full rounded-xl" />
      ) : events.isError ? (
        <p className="rounded-xl border border-danger/30 bg-danger/10 p-4 text-ui-sm text-danger-fg">
          {describeError(events.error).title}
        </p>
      ) : events.data.length === 0 ? (
        <p className="rounded-xl border border-border bg-surface-1 p-4 text-ui-sm text-text-3">
          No stores or renewals in this block.
        </p>
      ) : (
        <ul className="overflow-hidden rounded-xl border border-border bg-surface-1">
          {events.data.map((e) => (
            <li
              key={`${e.kind}:${e.index}`}
              className="flex flex-col gap-1.5 border-b border-border px-4 py-3 last:border-0"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-ui">
                  {e.kind === "stored" ? "Stored" : "Renewed"}{" "}
                  <span className="font-mono text-text-3">· index {e.index}</span>
                </span>
                {e.feePlanck !== null && (
                  <span className="font-mono text-ui-sm text-text-2 tabular">
                    {formatTpot(e.feePlanck)}
                  </span>
                )}
              </div>
              <CidText value={e.cid} href={`/proof/cid/${e.cid}`} />
              {e.txHash && (
                <CidText value={e.txHash} href={`/proof/tx/${e.txHash}`} className="text-text-3" />
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
