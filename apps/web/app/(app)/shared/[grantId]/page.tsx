"use client";

import { addressOf } from "@memdot/chain";
import { Button } from "@memdot/ui/components/button";
import { middleEllipsis } from "@memdot/ui/components/cid-text";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@memdot/ui/components/empty";
import { Skeleton } from "@memdot/ui/components/skeleton";
import { Spinner } from "@memdot/ui/components/spinner";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeftIcon, DownloadIcon } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { FileTypeIcon } from "@/components/files/file-icon";
import { saveBytes } from "@/components/files/file-sheet";
import { Page, PageHeader } from "@/components/page-header";
import { describeError } from "@/lib/errors";
import { formatBytes, formatRelative } from "@/lib/format";
import { useMemDot } from "@/lib/memdot";

export default function SharedGrantPage() {
  const memdot = useMemDot();
  const { grantId } = useParams<{ grantId: string }>();
  const [downloading, setDownloading] = useState<string | null>(null);
  const details = useQuery({
    queryKey: ["shared", grantId, "details"],
    queryFn: () => memdot.sharing.details(grantId),
  });
  const files = useQuery({
    queryKey: ["shared", grantId, "files"],
    queryFn: () => memdot.sharing.files(grantId),
  });
  const download = useMutation({
    mutationFn: async (objectId: string) => {
      setDownloading(objectId);
      const result = await memdot.sharing.get(grantId, objectId);
      saveBytes(result.data, result.name, result.mime);
    },
    onError: (error) => toast.error(describeError(error).title),
    onSettled: () => setDownloading(null),
  });

  return (
    <Page>
      <Link
        href="/shared"
        className="-mb-4 inline-flex w-fit items-center gap-1 text-ui-sm text-text-3 hover:text-foreground"
      >
        <ArrowLeftIcon className="size-3.5" /> Shared with me
      </Link>
      <PageHeader
        title={
          details.isPending ? <Skeleton className="h-8 w-48" /> : (details.data?.name ?? "Shared")
        }
        description={
          details.data
            ? `From ${middleEllipsis(addressOf(details.data.owner), 6, 6)} · ${details.data.scope === "read" ? "you can open" : "you can open and add"}${details.data.expiresAt ? ` · until ${formatRelative(details.data.expiresAt)}` : ""}`
            : undefined
        }
      />
      {details.isError || files.isError ? (
        <Empty className="rounded-xl border border-border py-12">
          <EmptyHeader>
            <EmptyTitle>This share cannot be opened</EmptyTitle>
            <EmptyDescription>{describeError(details.error ?? files.error).title}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : files.isPending ? (
        <Skeleton className="h-40 w-full rounded-xl" />
      ) : files.data.items.length === 0 ? (
        <Empty className="rounded-xl border border-dashed border-border-strong py-12">
          <EmptyHeader>
            <EmptyTitle>No files yet</EmptyTitle>
            <EmptyDescription>
              Files the owner adds while you have access appear here.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="overflow-hidden rounded-xl border border-border bg-surface-1">
          {files.data.items.map((file) => (
            <li
              key={file.id}
              className="flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-0"
            >
              <FileTypeIcon mime={file.mime} name={file.name} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-ui">{file.name ?? "Encrypted file"}</span>
                <span className="font-mono text-ui-sm text-text-3 tabular">
                  {file.size !== null ? formatBytes(file.size) : "—"} ·{" "}
                  {formatRelative(file.createdAt)}
                </span>
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => download.mutate(file.id)}
                disabled={downloading !== null}
              >
                {downloading === file.id ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <DownloadIcon data-icon="inline-start" />
                )}
                Download
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Page>
  );
}
