"use client";

import { addressOf, toBytes } from "@memdot/chain";
import type { Grant } from "@memdot/sdk";
import { middleEllipsis } from "@memdot/ui/components/cid-text";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@memdot/ui/components/empty";
import { Identicon } from "@memdot/ui/components/identicon";
import { Skeleton } from "@memdot/ui/components/skeleton";
import { Status, StatusIndicator, StatusLabel } from "@memdot/ui/components/status";
import { useQuery } from "@tanstack/react-query";
import { ChevronRightIcon, FileIcon, FolderIcon } from "lucide-react";
import Link from "next/link";
import { Page, PageHeader } from "@/components/page-header";
import { describeError } from "@/lib/errors";
import { formatRelative } from "@/lib/format";
import { useMemDot } from "@/lib/memdot";

const STATUS: Record<
  Grant["status"],
  { variant: "ok" | "warn" | "default" | "danger"; label: string }
> = {
  active: { variant: "ok", label: "Open" },
  pending: { variant: "warn", label: "Waiting for the owner" },
  expired: { variant: "default", label: "Expired" },
  revoked: { variant: "danger", label: "Revoked" },
};

/** One received grant: its name is decrypted on this device once the key is wrapped to you. */
function GrantRow({ grant }: { grant: Grant }) {
  const memdot = useMemDot();
  const openable = grant.status === "active";
  const details = useQuery({
    queryKey: ["shared", grant.id, "details"],
    enabled: openable,
    queryFn: () => memdot.sharing.details(grant.id),
  });
  const status = STATUS[grant.status];
  const body = (
    <>
      {grant.owner ? (
        <Identicon publicKey={toBytes(grant.owner)} size={32} />
      ) : (
        <span className="size-8 rounded-full bg-surface-3" />
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5 truncate text-ui">
          {grant.objectId ? (
            <FileIcon className="size-3.5 text-text-3" />
          ) : (
            <FolderIcon className="size-3.5 text-text-3" />
          )}
          {openable ? (
            details.isPending ? (
              <Skeleton className="h-4 w-32" />
            ) : (
              (details.data?.name ?? "Encrypted")
            )
          ) : grant.objectId ? (
            "A file"
          ) : (
            "A space"
          )}
        </span>
        <span className="text-ui-sm text-text-3">
          From {grant.owner ? middleEllipsis(addressOf(grant.owner), 6, 6) : "an owner"} ·{" "}
          {grant.scope === "read" ? "can open" : "can open and add"} ·{" "}
          {formatRelative(grant.createdAt)}
          {grant.expiresAt ? ` · expires ${formatRelative(grant.expiresAt)}` : ""}
        </span>
      </span>
      <Status variant={status.variant}>
        <StatusIndicator pulse={grant.status === "pending"} />
        <StatusLabel>{status.label}</StatusLabel>
      </Status>
      {openable && <ChevronRightIcon className="size-4 text-text-3" />}
    </>
  );
  return (
    <li className="border-b border-border last:border-0">
      {openable ? (
        <Link
          href={`/shared/${grant.id}`}
          className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2"
        >
          {body}
        </Link>
      ) : (
        <div className="flex items-center gap-3 px-4 py-3 opacity-80">{body}</div>
      )}
    </li>
  );
}

export default function SharedPage() {
  const memdot = useMemDot();
  const grants = useQuery({
    queryKey: ["grants", "received"],
    queryFn: () => memdot.sharing.list("received"),
  });
  return (
    <Page>
      <PageHeader
        title="Shared with me"
        description="Spaces and files others shared with your account. Keys are wrapped to you and open on this device."
      />
      {grants.isPending ? (
        <Skeleton className="h-32 w-full rounded-xl" />
      ) : grants.isError ? (
        <p className="rounded-xl border border-danger/30 bg-danger/10 p-4 text-ui-sm text-danger-fg">
          {describeError(grants.error).title}
        </p>
      ) : grants.data.items.length === 0 ? (
        <Empty className="rounded-xl border border-dashed border-border-strong py-14">
          <EmptyHeader>
            <EmptyTitle>Nothing shared with you yet</EmptyTitle>
            <EmptyDescription>
              Give someone your account address from Settings; what they share appears here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="overflow-hidden rounded-xl border border-border bg-surface-1">
          {grants.data.items.map((grant) => (
            <GrantRow key={grant.id} grant={grant} />
          ))}
        </ul>
      )}
    </Page>
  );
}
