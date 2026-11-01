"use client";

import {
  bitswapGet,
  contentHashFromCid,
  NodeTimeoutError,
  storageEventsAt,
  toHex,
  withNodeTimeout,
} from "@memdot/chain";
import { CidText } from "@memdot/ui/components/cid-text";
import { RetentionMeter } from "@memdot/ui/components/retention-meter";
import { Skeleton } from "@memdot/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Check, Checks, Fact, Facts } from "@/components/proof";
import { describeError } from "@/lib/errors";
import { formatBytes, formatNumber, formatRelative } from "@/lib/format";
import { useMemDot } from "@/lib/memdot";
import { retentionOf } from "@/lib/retention";
import { blocksToDuration } from "@/lib/time";

const KIND: Record<string, string> = {
  file: "File chunk or manifest",
  segment: "Segment of small files",
  key_bundle: "Key bundle",
  grant_key: "Wrapped share key",
  index_snapshot: "Index snapshot",
};

const NO_ANSWER_LABEL =
  "A Portaldot node didn't answer in time. That says nothing about the data. Reload to ask again.";

/** A slow node gets one more chance; a real answer, even a bad one, is final. */
const askOnceMore = (failures: number, error: Error) =>
  error instanceof NodeTimeoutError && failures < 1;

export default function CidProofPage() {
  const memdot = useMemDot();
  const { cid } = useParams<{ cid: string }>();
  const proof = useQuery({
    queryKey: ["proof", "cid", cid],
    queryFn: () => memdot.proof.cid(cid),
    retry: false,
  });
  const bytes = useQuery({
    queryKey: ["proof", "cid", cid, "bitswap"],
    queryFn: async () => (await bitswapGet((await memdot.chain()).client, cid)).length,
    retry: askOnceMore,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const current = proof.data?.current;
  const event = useQuery({
    queryKey: ["proof", "cid", cid, "event", current?.block],
    enabled: Boolean(current),
    queryFn: async () => {
      if (!current) return false;
      const hash = toHex(contentHashFromCid(cid));
      const events = await withNodeTimeout(
        memdot.chain().then((chain) => storageEventsAt(chain, current.block)),
        `events of block ${current.block}`,
      );
      return events.some((e) => e.index === current.index && toHex(e.contentHash) === hash);
    },
    retry: askOnceMore,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const retention = retentionOf(
    proof.data?.expiresAtBlock ?? null,
    proof.data?.headBlock ?? null,
    proof.data?.status === "lost",
  );

  return (
    <>
      <div className="flex flex-col gap-2">
        <span className="eyebrow">Content ID</span>
        <h1 className="font-mono text-h3 break-all">{cid}</h1>
        <p className="text-ui text-text-2">
          Encrypted bytes stored with Portaldot's TransactionStorage. The CID is their blake2b-256
          hash, so anyone can check them.
        </p>
      </div>

      <Checks>
        <Check
          state={
            bytes.isPending
              ? "running"
              : bytes.isSuccess
                ? "ok"
                : bytes.error instanceof NodeTimeoutError
                  ? "unknown"
                  : "failed"
          }
          label={
            bytes.isPending
              ? "Fetching the bytes from a Portaldot node…"
              : bytes.isSuccess
                ? "A node returned the bytes and they hash to this CID"
                : bytes.error instanceof NodeTimeoutError
                  ? NO_ANSWER_LABEL
                  : "No node returned these bytes"
          }
          detail={
            bytes.isSuccess
              ? `${formatBytes(bytes.data)} via bitswap_v1_get`
              : bytes.isError && !(bytes.error instanceof NodeTimeoutError)
                ? describeError(bytes.error).title
                : undefined
          }
        />
        {current && (
          <Check
            state={
              event.isPending ? "running" : event.isError ? "unknown" : event.data ? "ok" : "failed"
            }
            label={
              event.isPending
                ? `Reading block #${formatNumber(current.block)}…`
                : event.isError
                  ? NO_ANSWER_LABEL
                  : event.data
                    ? `Block #${formatNumber(current.block)} records this content hash at index ${current.index}`
                    : `Block #${formatNumber(current.block)} does not record it at index ${current.index}`
            }
          />
        )}
      </Checks>

      {proof.isPending ? (
        <Skeleton className="h-48 w-full rounded-xl" />
      ) : proof.isError ? (
        <p className="rounded-xl border border-border bg-surface-1 p-4 text-ui-sm text-text-3">
          MemDot has no record of this CID. {describeError(proof.error).title}
        </p>
      ) : (
        <>
          <Facts>
            <Fact label="What it is">
              {proof.data.kind ? (KIND[proof.data.kind] ?? proof.data.kind) : "Unknown"} ·{" "}
              {proof.data.role}
            </Fact>
            <Fact label="Size">
              <span className="font-mono tabular">{formatBytes(proof.data.sizeBytes)}</span>
            </Fact>
            <Fact label="Status">{proof.data.status}</Fact>
            {proof.data.registry && (
              <Fact label="Owner's record">
                <Link href="/proof/registry" className="font-mono tabular hover:underline">
                  Registry, block #{formatNumber(proof.data.registry.block)}
                </Link>
              </Fact>
            )}
            {current && (
              <Fact label="Lives at">
                <Link
                  href={`/proof/block/${current.block}`}
                  className="font-mono tabular hover:underline"
                >
                  #{formatNumber(current.block)} · index {current.index}
                </Link>
              </Fact>
            )}
            {proof.data.firstStore?.txHash && (
              <Fact label="First stored by">
                <CidText
                  value={proof.data.firstStore.txHash}
                  href={`/proof/tx/${proof.data.firstStore.txHash}`}
                />
              </Fact>
            )}
            <Fact label="Retention">
              <span className="inline-flex items-center gap-2">
                <RetentionMeter remaining={retention.remaining} state={retention.state} />
                <span className="font-mono text-ui-sm text-text-2 tabular">
                  {retention.blocksLeft !== null && retention.blocksLeft > 0
                    ? `${blocksToDuration(retention.blocksLeft)} left`
                    : retention.state}
                </span>
              </span>
            </Fact>
          </Facts>
          <section className="flex flex-col gap-2">
            <h2 className="text-h3">Renewals</h2>
            {proof.data.renewals.length === 0 ? (
              <p className="text-ui-sm text-text-3">
                Not renewed yet. MemDot's keeper renews it before its 7-day window ends.
              </p>
            ) : (
              <ul className="overflow-hidden rounded-xl border border-border bg-surface-1">
                {proof.data.renewals.map((r) => (
                  <li
                    key={r.txHash}
                    className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-4 py-2.5 last:border-0"
                  >
                    <CidText value={r.txHash} href={`/proof/tx/${r.txHash}`} />
                    <span className="font-mono text-ui-sm text-text-2 tabular">
                      #{formatNumber(r.from.block)} → #{formatNumber(r.to.block)}
                    </span>
                    <span className="ml-auto text-ui-sm text-text-3">{formatRelative(r.at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </>
  );
}
