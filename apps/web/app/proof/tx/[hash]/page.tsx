"use client";

import { extrinsicHashes } from "@memdot/chain";
import { CidText } from "@memdot/ui/components/cid-text";
import { Skeleton } from "@memdot/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Check, Checks, Fact, Facts } from "@/components/proof";
import { describeError } from "@/lib/errors";
import { formatBytes, formatNumber } from "@/lib/format";
import { useMemDot } from "@/lib/memdot";

export default function TxProofPage() {
  const memdot = useMemDot();
  const { hash } = useParams<{ hash: string }>();
  const proof = useQuery({
    queryKey: ["proof", "tx", hash],
    queryFn: () => memdot.proof.tx(hash),
    retry: false,
  });
  const block = proof.data?.location.block;
  const included = useQuery({
    queryKey: ["proof", "tx", hash, "included", block],
    enabled: block !== undefined,
    queryFn: async () =>
      (await extrinsicHashes(await memdot.chain(), block as number)).includes(hash.toLowerCase()),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });

  return (
    <>
      <div className="flex flex-col gap-2">
        <span className="eyebrow">Transaction</span>
        <h1 className="font-mono text-h3 break-all">{hash}</h1>
      </div>
      {proof.isPending ? (
        <Skeleton className="h-40 w-full rounded-xl" />
      ) : proof.isError ? (
        <p className="rounded-xl border border-border bg-surface-1 p-4 text-ui-sm text-text-3">
          MemDot has no record of this transaction. {describeError(proof.error).title}
        </p>
      ) : (
        <>
          <Checks>
            <Check
              state={included.isPending ? "running" : included.data ? "ok" : "failed"}
              label={
                included.isPending
                  ? `Reading block #${formatNumber(proof.data.location.block)}…`
                  : included.data
                    ? `Block #${formatNumber(proof.data.location.block)} contains this transaction`
                    : `This hash is not among block #${formatNumber(proof.data.location.block)}'s transactions`
              }
            />
          </Checks>
          <Facts>
            <Fact label="Type">
              {proof.data.type === "store"
                ? "TransactionStorage.store"
                : "TransactionStorage.renew"}
            </Fact>
            <Fact label="Content">
              <CidText value={proof.data.cid} href={`/proof/cid/${proof.data.cid}`} />
            </Fact>
            <Fact label="Size">
              <span className="font-mono tabular">{formatBytes(proof.data.sizeBytes)}</span>
            </Fact>
            <Fact label="Location">
              <Link
                href={`/proof/block/${proof.data.location.block}`}
                className="font-mono tabular hover:underline"
              >
                #{formatNumber(proof.data.location.block)} · index {proof.data.location.index}
              </Link>
            </Fact>
          </Facts>
        </>
      )}
    </>
  );
}
