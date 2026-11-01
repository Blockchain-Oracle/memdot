"use client";

import { cidFromContentHash } from "@memdot/chain";
import { REGISTRY_ADDRESS, REGISTRY_DEPLOY_BLOCK } from "@memdot/config";
import { CidText } from "@memdot/ui/components/cid-text";
import { Skeleton } from "@memdot/ui/components/skeleton";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { type Hex, hexToBytes } from "viem";
import { Fact, Facts } from "@/components/proof";
import { describeError } from "@/lib/errors";
import { formatNumber } from "@/lib/format";
import { type RegistryRecord, readRegistryRecords } from "@/lib/registry";

const SHOWN = 50;
const REFRESH_MS = 30_000;

const LABEL: Record<NonNullable<RegistryRecord["name"]>, string> = {
  RegisterKey: "Sharing key registered",
  DeleteAccount: "Account deleted",
  CreateSpace: "Space created",
  DeleteSpace: "Space deleted",
  AddObjects: "Encrypted object recorded",
  TombstoneObjects: "Object deleted",
  Grant: "Access granted",
  RevokeGrant: "Access revoked",
  RegisterAgent: "Agent registered",
  RevokeAgent: "Agent revoked",
};

function RecordDetail({ record }: { record: RegistryRecord }) {
  const hashes = record.fields?.contentHashes as Hex[] | undefined;
  const grantee = record.name === "Grant" ? (record.fields?.grantee as string) : null;
  return (
    <>
      {hashes?.map((hash) => {
        const cid = cidFromContentHash(hexToBytes(hash));
        return <CidText key={hash} value={cid} href={`/proof/cid/${cid}`} />;
      })}
      {grantee && <CidText value={grantee} className="text-text-3" />}
    </>
  );
}

/** Every owner-signed record in MemDotRegistry, read straight from the chain by this browser. */
export default function RegistryProofPage() {
  const records = useQuery({
    queryKey: ["proof", "registry"],
    queryFn: readRegistryRecords,
    refetchInterval: REFRESH_MS,
    retry: false,
  });

  return (
    <>
      <div className="flex flex-col gap-2">
        <span className="eyebrow">Registry</span>
        <h1 className="text-h1">Who stored what, signed by its owner</h1>
        <p className="text-ui text-text-2">
          Every space, stored object and share is logged here with its owner&apos;s signature, which
          the contract checks with Portaldot&apos;s sr25519 precompile. Your browser reads these
          records from Portaldot&apos;s EVM RPC, not from MemDot.
        </p>
      </div>

      <Facts>
        <Fact label="Contract">
          <CidText value={REGISTRY_ADDRESS} />
        </Fact>
        <Fact label="Deployed">
          <span className="font-mono tabular">Block #{formatNumber(REGISTRY_DEPLOY_BLOCK)}</span>
        </Fact>
        <Fact label="Network">Portaldot V3 testnet</Fact>
      </Facts>

      <section className="flex flex-col gap-3">
        <h2 className="text-h3">
          Recent records
          {records.data && (
            <span className="ml-2 font-mono text-ui text-text-3 tabular">
              {formatNumber(records.data.length)}
            </span>
          )}
        </h2>
        {records.isPending ? (
          <Skeleton className="h-48 w-full rounded-xl" />
        ) : records.isError ? (
          <p className="rounded-xl border border-danger/30 bg-danger/10 p-4 text-ui-sm text-danger-fg">
            {describeError(records.error).title}
          </p>
        ) : records.data.length === 0 ? (
          <p className="rounded-xl border border-border bg-surface-1 p-4 text-ui-sm text-text-3">
            No records yet.
          </p>
        ) : (
          <ul className="overflow-hidden rounded-xl border border-border bg-surface-1">
            {records.data.slice(0, SHOWN).map((record) => (
              <li
                key={`${record.owner}:${record.block}:${record.name}:${JSON.stringify(record.fields, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}`}
                className="flex flex-col gap-1.5 border-b border-border px-4 py-3 last:border-0"
              >
                <div className="flex items-center justify-between gap-3">
                  <span className="text-ui">
                    {record.name ? LABEL[record.name] : "Unknown record"}
                  </span>
                  <Link
                    href={`/proof/block/${record.block}`}
                    className="shrink-0 font-mono text-ui-sm text-text-2 tabular hover:underline"
                  >
                    #{formatNumber(record.block)}
                  </Link>
                </div>
                <RecordDetail record={record} />
                <span className="flex items-center gap-2 text-ui-sm text-text-3">
                  Signed by <CidText value={record.owner} className="text-text-3" />
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
