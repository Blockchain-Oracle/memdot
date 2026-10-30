"use client";

import type { ListedFile, VerifyResult } from "@memdot/sdk";
import { Button } from "@memdot/ui/components/button";
import { CidText } from "@memdot/ui/components/cid-text";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@memdot/ui/components/dropdown-menu";
import { RetentionMeter } from "@memdot/ui/components/retention-meter";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@memdot/ui/components/sheet";
import { Skeleton } from "@memdot/ui/components/skeleton";
import { Spinner } from "@memdot/ui/components/spinner";
import { cn } from "@memdot/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleCheckIcon,
  CircleXIcon,
  DownloadIcon,
  EllipsisIcon,
  LockIcon,
  PencilIcon,
  RefreshCwIcon,
  Share2Icon,
  ShieldCheckIcon,
  TrashIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { describeError } from "@/lib/errors";
import { formatBytes, formatDualTime, formatNumber, formatRelative } from "@/lib/format";
import { useMemDot } from "@/lib/memdot";
import { retentionOf } from "@/lib/retention";
import { blocksToDuration } from "@/lib/time";
import { FileTypeIcon } from "./file-icon";
import { FileStatus } from "./file-table";

const PREVIEW_MAX_BYTES = 1024 * 1024;
const TEXT_PREVIEW_CHARS = 4000;

/** Saves decrypted bytes through a temporary object URL. */
export function saveBytes(data: Uint8Array, name: string, mime: string) {
  const url = URL.createObjectURL(new Blob([data as Uint8Array<ArrayBuffer>], { type: mime }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t border-border px-5 py-4">
      <h3 className="eyebrow">{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 text-ui-sm">
      <span className="text-text-3">{label}</span>
      <span className="min-w-0 text-right text-foreground">{children}</span>
    </div>
  );
}

/**
 * One file: preview, integrity checked from this browser, where it lives on chain, when it is
 * renewed, how it is encrypted, who can open it, and its versions.
 */
export function FileSheet({
  file,
  onOpenChange,
  onShare,
  onRename,
  onDelete,
  onOpenVersion,
}: {
  file: ListedFile | null;
  onOpenChange: (open: boolean) => void;
  onShare: (file: ListedFile) => void;
  onRename: (file: ListedFile) => void;
  onDelete: (file: ListedFile) => void;
  onOpenVersion: (id: string) => void;
}) {
  const memdot = useMemDot();
  const queryClient = useQueryClient();
  const [verified, setVerified] = useState<VerifyResult | null>(null);
  const id = file?.id;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a different file starts unverified
  useEffect(() => setVerified(null), [id]);

  const detail = useQuery({
    queryKey: ["file", id, "detail"],
    enabled: Boolean(id),
    queryFn: async () => {
      const own = await memdot.files.detail(id as string);
      // Small files live inside a segment: its blobs are the ones on chain.
      return own.segmentId
        ? { own, holder: await memdot.files.detail(own.segmentId) }
        : { own, holder: own };
    },
  });
  const versions = useQuery({
    queryKey: ["file", id, "versions"],
    enabled: Boolean(id),
    queryFn: () => memdot.files.versions(id as string),
  });
  const grants = useQuery({
    queryKey: ["grants", "given", file?.spaceId],
    enabled: Boolean(file?.spaceId),
    queryFn: () => memdot.sharing.list("given", file?.spaceId ?? undefined),
  });
  const previewable =
    file !== null &&
    (file.size ?? Number.POSITIVE_INFINITY) <= PREVIEW_MAX_BYTES &&
    (file.mime?.startsWith("image/") ||
      file.mime?.startsWith("text/") ||
      file.mime === "application/json");
  const preview = useQuery({
    queryKey: ["file", id, "preview"],
    enabled: Boolean(id) && previewable,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: () => memdot.files.get(id as string),
  });
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!preview.data?.mime.startsWith("image/")) return;
    const url = URL.createObjectURL(
      new Blob([preview.data.data as Uint8Array<ArrayBuffer>], { type: preview.data.mime }),
    );
    setImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [preview.data]);

  const download = useMutation({
    mutationFn: async () => {
      const result = preview.data ?? (await memdot.files.get(id as string));
      saveBytes(result.data, result.name, result.mime);
    },
    onError: (error) => toast.error(describeError(error).title),
  });
  const verify = useMutation({
    mutationFn: () => memdot.files.verify(id as string),
    onSuccess: setVerified,
    onError: (error) => toast.error(describeError(error).title),
  });
  const renew = useMutation({
    mutationFn: () => memdot.files.renew(id as string),
    onSuccess: async (job) => {
      toast.success(
        `Renewed in block #${job.block ? formatNumber(job.block) : "?"}. Same CID, a fresh 7 days.`,
      );
      await queryClient.invalidateQueries({ queryKey: ["file", id] });
      await queryClient.invalidateQueries({ queryKey: ["files", file?.spaceId] });
    },
    onError: (error) => toast.error(describeError(error).title),
  });

  const holder = detail.data?.holder;
  const head = holder?.headBlock ?? null;
  const expiresAt =
    holder?.blobs.reduce<number | null>(
      (min, b) =>
        b.expiresAtBlock === null
          ? min
          : min === null
            ? b.expiresAtBlock
            : Math.min(min, b.expiresAtBlock),
      null,
    ) ??
    file?.expiresAtBlock ??
    null;
  const retention = retentionOf(expiresAt, head, file?.status === "lost");
  const fileGrants =
    grants.data?.items.filter(
      (g) => (g.objectId === id || g.objectId === null) && g.status !== "revoked",
    ) ?? [];
  const created = file ? formatDualTime(file.createdAt) : null;

  return (
    <Sheet open={file !== null} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-[480px]">
        {file && (
          <>
            <SheetHeader className="gap-3 p-5">
              <div className="flex items-start gap-3">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-surface-2">
                  <FileTypeIcon mime={file.mime} name={file.name} className="size-5" />
                </span>
                <div className="flex min-w-0 flex-col gap-1">
                  <SheetTitle className="truncate text-h2">
                    {file.name ?? "Encrypted file"}
                  </SheetTitle>
                  <SheetDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="inline-flex items-center gap-1">
                      <LockIcon className="size-3" aria-hidden="true" /> Encrypted
                    </span>
                    <span>·</span>
                    <span className="font-mono tabular">
                      {file.size !== null ? formatBytes(file.size) : "—"}
                    </span>
                    {file.mime && (
                      <>
                        <span>·</span>
                        <span>{file.mime}</span>
                      </>
                    )}
                  </SheetDescription>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={() => download.mutate()} disabled={download.isPending}>
                  {download.isPending ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <DownloadIcon data-icon="inline-start" />
                  )}
                  Download
                </Button>
                <Button size="sm" variant="outline" onClick={() => onShare(file)}>
                  <Share2Icon data-icon="inline-start" /> Share
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => verify.mutate()}
                  disabled={verify.isPending}
                >
                  {verify.isPending ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <ShieldCheckIcon data-icon="inline-start" />
                  )}
                  Verify
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="icon-sm" variant="ghost" aria-label="More actions">
                      <EllipsisIcon />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => onRename(file)}>
                      <PencilIcon /> Rename
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => renew.mutate()} disabled={renew.isPending}>
                      <RefreshCwIcon /> Renew now
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={() => onDelete(file)}>
                      <TrashIcon /> Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </SheetHeader>

            {previewable && (
              <section className="border-t border-border bg-surface-2 p-5">
                {preview.isPending ? (
                  <Skeleton className="h-40 w-full" />
                ) : imageUrl ? (
                  // biome-ignore lint/performance/noImgElement: a decrypted blob URL, not an optimizable asset
                  <img
                    src={imageUrl}
                    alt={file.name ?? ""}
                    className="mx-auto max-h-64 rounded-lg"
                  />
                ) : preview.data ? (
                  <pre className="max-h-64 overflow-auto rounded-lg bg-surface-1 p-3 font-mono text-[12px] leading-5 whitespace-pre-wrap text-text-2">
                    {new TextDecoder().decode(preview.data.data).slice(0, TEXT_PREVIEW_CHARS)}
                  </pre>
                ) : null}
                <p className="mt-2 text-ui-sm text-text-3">Decrypted on this device.</p>
              </section>
            )}

            <Section title="Integrity">
              {detail.isPending ? (
                <Skeleton className="h-10 w-full" />
              ) : (
                holder?.blobs.map((blob) => (
                  <Row
                    key={blob.cid}
                    label={
                      blob.role === "root"
                        ? detail.data?.own.segmentId
                          ? "Segment"
                          : "Manifest"
                        : `Chunk ${blob.index + 1}`
                    }
                  >
                    <CidText value={blob.cid} href={`/proof/cid/${blob.cid}`} />
                  </Row>
                ))
              )}
              {verified ? (
                <p
                  className={cn(
                    "flex items-start gap-2 text-ui-sm",
                    verified.ok ? "text-ok-fg" : "text-danger-fg",
                  )}
                >
                  {verified.ok ? (
                    <CircleCheckIcon className="mt-0.5 size-4 shrink-0" />
                  ) : (
                    <CircleXIcon className="mt-0.5 size-4 shrink-0" />
                  )}
                  {verified.ok
                    ? `Hash matches. Read from Portaldot by this browser, recorded in block #${formatNumber(verified.blobs[0]?.block ?? 0)}.`
                    : `${verified.blobs.filter((b) => !b.retrievable || !b.onChain).length} blob(s) did not verify: the bytes or the chain record do not match.`}
                </p>
              ) : (
                <p className="text-ui-sm text-text-3">
                  Verify fetches each blob from a Portaldot node, hashes it, and checks the block's
                  events. MemDot is not asked.
                </p>
              )}
            </Section>

            <Section title="Location on chain">
              {detail.isPending ? (
                <Skeleton className="h-10 w-full" />
              ) : (
                holder?.blobs.map((blob) => (
                  <div key={blob.cid} className="flex flex-col gap-1.5">
                    <Row label="Block · index">
                      {blob.block !== null ? (
                        <Link
                          href={`/proof/block/${blob.block}`}
                          className="font-mono tabular underline-offset-4 hover:underline"
                        >
                          #{formatNumber(blob.block)} · {blob.indexInBlock}
                        </Link>
                      ) : (
                        <span className="text-text-3">Not stored yet</span>
                      )}
                    </Row>
                    {blob.txHash && (
                      <Row label="Transaction">
                        <CidText value={blob.txHash} href={`/proof/tx/${blob.txHash}`} />
                      </Row>
                    )}
                  </div>
                ))
              )}
            </Section>

            <Section title="Renewal">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2.5">
                  <RetentionMeter remaining={retention.remaining} state={retention.state} />
                  <span className="font-mono text-ui-sm text-text-2 tabular">
                    {retention.blocksLeft !== null && retention.blocksLeft > 0
                      ? `${blocksToDuration(retention.blocksLeft)} left`
                      : retention.state === "pending"
                        ? "Waiting for a block"
                        : retention.state === "lost"
                          ? "Lost"
                          : "Re-storing"}
                  </span>
                </div>
                <FileStatus file={file} retention={retention} />
              </div>
              {retention.renewAtBlock !== null && (
                <Row label="Keeper renews at">
                  <span className="font-mono tabular">
                    #{formatNumber(retention.renewAtBlock)}
                    {head !== null && retention.renewAtBlock > head
                      ? ` · in ${blocksToDuration(retention.renewAtBlock - head)}`
                      : " · due now"}
                  </span>
                </Row>
              )}
              <Button
                variant="outline"
                size="sm"
                className="w-fit"
                onClick={() => renew.mutate()}
                disabled={renew.isPending || retention.state === "pending"}
              >
                {renew.isPending ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <RefreshCwIcon data-icon="inline-start" />
                )}
                Renew now
              </Button>
            </Section>

            <Section title="Encryption">
              <Row label="Scheme">age · X25519 + ChaCha20-Poly1305</Row>
              <Row label="Key">Space key, epoch {file.keyEpoch ?? 0}</Row>
              <Row label="Name and type">Sealed to the space key</Row>
              {file.segmentId && <Row label="Packing">One entry in an encrypted segment</Row>}
            </Section>

            <Section title="Access">
              {fileGrants.length === 0 ? (
                <p className="text-ui-sm text-text-3">Only you. Share to give someone a key.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {fileGrants.map((grant) => (
                    <li
                      key={grant.id}
                      className="flex items-center justify-between gap-3 text-ui-sm"
                    >
                      <CidText value={grant.grantee} copy={false} />
                      <span className="text-text-3">
                        {grant.objectId ? "This file" : "Whole space"} · {grant.status}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <Button variant="ghost" size="sm" className="w-fit" onClick={() => onShare(file)}>
                <Share2Icon data-icon="inline-start" /> Manage access
              </Button>
            </Section>

            <Section title="Versions">
              {versions.isPending ? (
                <Skeleton className="h-8 w-full" />
              ) : (
                <ul className="flex flex-col">
                  {versions.data?.map((version, i) => (
                    <li key={version.id}>
                      <button
                        type="button"
                        onClick={() => onOpenVersion(version.id)}
                        className={cn(
                          "flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-ui-sm hover:bg-surface-2",
                          version.id === file.id && "bg-surface-2",
                        )}
                      >
                        <span className="truncate">
                          v{(versions.data?.length ?? 0) - i} · {version.name ?? "Encrypted"}
                        </span>
                        <span className="shrink-0 text-text-3">
                          {formatRelative(version.createdAt)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {created && (
                <p className="text-ui-sm text-text-3">
                  Stored {created.local} · {created.utc}
                </p>
              )}
            </Section>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
