"use client";

import type { Folder, ListedFile } from "@memdot/sdk";
import { Button } from "@memdot/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@memdot/ui/components/empty";
import { Input } from "@memdot/ui/components/input";
import { SegmentedControl } from "@memdot/ui/components/segmented-control";
import { Skeleton } from "@memdot/ui/components/skeleton";
import { Spinner } from "@memdot/ui/components/spinner";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import type { RowSelectionState } from "@tanstack/react-table";
import {
  ChevronRightIcon,
  DownloadIcon,
  FolderPlusIcon,
  RefreshCwIcon,
  SearchIcon,
  Share2Icon,
  TrashIcon,
  UploadIcon,
  XIcon,
} from "lucide-react";
import { useParams, usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog, NameDialog } from "@/components/files/file-dialogs";
import { FileSheet, saveBytes } from "@/components/files/file-sheet";
import { type FileRow, FileTable } from "@/components/files/file-table";
import { UploadSheet } from "@/components/files/upload-sheet";
import { Page, PageHeader } from "@/components/page-header";
import { ShareDialog, type ShareTarget } from "@/components/share/share-dialog";
import { describeError } from "@/lib/errors";
import { formatBytes } from "@/lib/format";
import { useMemDot } from "@/lib/memdot";
import { useSpaces } from "@/lib/queries";
import { retentionOf } from "@/lib/retention";

const PAGE = 100;
const FILTERS = [
  { value: "all", label: "All" },
  { value: "stored", label: "Stored" },
  { value: "flight", label: "In flight" },
  { value: "expiring", label: "Expiring" },
];

export default function SpacePage() {
  return (
    <Suspense>
      <SpaceFiles />
    </Suspense>
  );
}

function SpaceFiles() {
  const memdot = useMemDot();
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const params = useSearchParams();
  const { spaceId } = useParams<{ spaceId: string }>();
  const folderId = params.get("folder");
  const { data: spaces, isPending: spacesPending } = useSpaces();
  const space = spaces?.find((s) => s.id === spaceId);

  const [uploadOpen, setUploadOpen] = useState(params.get("upload") === "1");
  const [share, setShare] = useState<ShareTarget | null>(null);
  const [openFile, setOpenFile] = useState<ListedFile | null>(null);
  const [renaming, setRenaming] = useState<ListedFile | null>(null);
  const [deleting, setDeleting] = useState<ListedFile[] | null>(null);
  const [newFolder, setNewFolder] = useState(false);
  const [selection, setSelection] = useState<RowSelectionState>({});
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");

  // Deep links from ⌘K, New and Overview open the sheet or dialog once, then clean the URL.
  useEffect(() => {
    if (!space) return;
    if (params.get("share") === "1") setShare({ kind: "space", space });
    if (params.get("upload") === "1" || params.get("share") === "1") {
      router.replace(folderId ? `${pathname}?folder=${folderId}` : pathname);
    }
  }, [space, params, folderId, pathname, router]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: clear the selection whenever the folder or space changes
  useEffect(() => setSelection({}), [folderId, spaceId]);

  const folders = useQuery({
    queryKey: ["folders", spaceId],
    queryFn: () => memdot.folders.list(spaceId),
  });
  const files = useInfiniteQuery({
    queryKey: ["files", spaceId, folderId ?? "root"],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      memdot.files.list({
        spaceId,
        folderId: folderId ?? "root",
        limit: PAGE,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    // Keep stages moving while something is still on its way to the chain.
    refetchInterval: (query) =>
      query.state.data?.pages.some((p) =>
        p.items.some((f) => f.status === "queued" || f.status === "uploading"),
      )
        ? 3_000
        : false,
  });

  const headBlock = files.data?.pages[0]?.headBlock ?? null;
  const allFiles = useMemo(() => files.data?.pages.flatMap((p) => p.items) ?? [], [files.data]);
  const currentFolder = folders.data?.find((f) => f.id === folderId) ?? null;
  const path = useMemo(() => {
    const chain: Folder[] = [];
    let cursor = currentFolder;
    while (cursor) {
      chain.unshift(cursor);
      const parentId = cursor.parentId;
      cursor = parentId ? (folders.data?.find((f) => f.id === parentId) ?? null) : null;
    }
    return chain;
  }, [currentFolder, folders.data]);

  const rows = useMemo<FileRow[]>(() => {
    const needle = search.trim().toLowerCase();
    const matches = (name: string | null) => !needle || (name ?? "").toLowerCase().includes(needle);
    const folderRows: FileRow[] =
      filter === "all"
        ? (folders.data ?? [])
            .filter((f) => (f.parentId ?? null) === folderId && matches(f.name))
            .map((f) => ({
              kind: "folder",
              id: f.id,
              name: f.name,
              folder: f,
              size: null,
              updated: f.createdAt,
            }))
        : [];
    const fileRows: FileRow[] = allFiles
      .filter((file) => matches(file.name))
      .filter((file) => {
        if (filter === "all") return true;
        if (filter === "flight") return file.status === "queued" || file.status === "uploading";
        const retention = retentionOf(file.expiresAtBlock, headBlock, file.status === "lost");
        if (filter === "expiring") return file.status === "stored" && retention.state === "warn";
        return file.status === "stored" && retention.state === "ok";
      })
      .map((file) => ({
        kind: "file",
        id: file.id,
        name: file.name,
        file,
        size: file.size ?? 0,
        updated: file.createdAt,
      }));
    return [...folderRows, ...fileRows];
  }, [allFiles, folders.data, folderId, search, filter, headBlock]);

  const selected = allFiles.filter((f) => selection[f.id]);
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["files", spaceId] }),
      queryClient.invalidateQueries({ queryKey: ["spaces"] }),
      queryClient.invalidateQueries({ queryKey: ["usage"] }),
    ]);
  const goToFolder = (id: string | null) => router.push(id ? `${pathname}?folder=${id}` : pathname);

  if (!spacesPending && !space) {
    return (
      <Page>
        <Empty className="rounded-xl border border-border py-16">
          <EmptyHeader>
            <EmptyTitle>This space is not yours, or it was deleted</EmptyTitle>
            <EmptyDescription>Pick another one from the switcher.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" onClick={() => router.push("/overview")}>
              Back to Overview
            </Button>
          </EmptyContent>
        </Empty>
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        title={space?.name ?? <Skeleton className="h-8 w-48" />}
        description={
          space ? (
            <span className="font-mono tabular">
              {formatBytes(space.usedBytes)} of {formatBytes(space.quotaBytes)} ·{" "}
              {space.mode === "sponsored" ? "sponsored by MemDot" : "self-signed"} · key epoch{" "}
              {space.keyEpoch}
            </span>
          ) : undefined
        }
        actions={
          space && (
            <>
              <Button variant="outline" onClick={() => setShare({ kind: "space", space })}>
                <Share2Icon data-icon="inline-start" /> Share
              </Button>
              <Button variant="outline" onClick={() => setNewFolder(true)}>
                <FolderPlusIcon data-icon="inline-start" /> New folder
              </Button>
              <Button onClick={() => setUploadOpen(true)}>
                <UploadIcon data-icon="inline-start" /> Upload
              </Button>
            </>
          )
        }
      />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <nav aria-label="Folder" className="flex min-w-0 items-center gap-1 text-ui">
          <button
            type="button"
            onClick={() => goToFolder(null)}
            className={path.length ? "text-text-3 hover:text-foreground" : "text-foreground"}
          >
            All files
          </button>
          {path.map((folder, i) => (
            <span key={folder.id} className="flex min-w-0 items-center gap-1">
              <ChevronRightIcon className="size-3.5 shrink-0 text-text-4" />
              <button
                type="button"
                onClick={() => goToFolder(folder.id)}
                className={
                  i === path.length - 1
                    ? "truncate text-foreground"
                    : "truncate text-text-3 hover:text-foreground"
                }
              >
                {folder.name ?? "Encrypted folder"}
              </button>
            </span>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <div className="relative w-full sm:w-56">
            <SearchIcon className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-text-4" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Filter by name"
              aria-label="Filter by name"
              className="pl-8"
            />
          </div>
          <SegmentedControl
            label="Status"
            options={FILTERS}
            value={filter}
            onValueChange={setFilter}
            className="hidden lg:inline-block"
          />
        </div>
      </div>

      {files.isPending || folders.isPending ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: 5 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows
            <Skeleton key={i} className="h-11 w-full" />
          ))}
        </div>
      ) : files.isError ? (
        <Empty className="rounded-xl border border-border py-12">
          <EmptyHeader>
            <EmptyTitle>Files did not load</EmptyTitle>
            <EmptyDescription>
              {describeError(files.error).title}
              {describeError(files.error).requestId
                ? ` · request ${describeError(files.error).requestId}`
                : ""}
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" onClick={() => files.refetch()}>
              Try again
            </Button>
          </EmptyContent>
        </Empty>
      ) : rows.length === 0 ? (
        <Empty className="rounded-xl border border-dashed border-border-strong py-16">
          <EmptyHeader>
            <EmptyTitle>
              {search || filter !== "all" ? "Nothing matches" : "No files here yet"}
            </EmptyTitle>
            <EmptyDescription>
              {search || filter !== "all"
                ? "Try another name or status."
                : "Files are encrypted on this device, stored on Portaldot and renewed automatically."}
            </EmptyDescription>
          </EmptyHeader>
          {!search && filter === "all" && (
            <EmptyContent>
              <Button onClick={() => setUploadOpen(true)}>
                <UploadIcon data-icon="inline-start" /> Upload files
              </Button>
            </EmptyContent>
          )}
        </Empty>
      ) : (
        <FileTable
          rows={rows}
          headBlock={headBlock}
          selection={selection}
          onSelectionChange={setSelection}
          onOpenFile={setOpenFile}
          onOpenFolder={(folder) => goToFolder(folder.id)}
        />
      )}
      {files.hasNextPage && (
        <Button
          variant="ghost"
          className="self-center"
          onClick={() => files.fetchNextPage()}
          disabled={files.isFetchingNextPage}
        >
          {files.isFetchingNextPage && <Spinner data-icon="inline-start" />}
          Load more
        </Button>
      )}

      {selected.length > 0 && (
        <div className="fixed inset-x-0 bottom-6 z-30 flex justify-center px-4">
          <div className="flex items-center gap-1 rounded-xl border border-border-strong bg-popover p-1.5 shadow-overlay">
            <span className="px-2 font-mono text-ui-sm tabular">{selected.length} selected</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                for (const file of selected) {
                  try {
                    const result = await memdot.files.get(file.id);
                    saveBytes(result.data, result.name, result.mime);
                  } catch (error) {
                    toast.error(describeError(error).title);
                  }
                }
              }}
            >
              <DownloadIcon /> Download
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={async () => {
                const renewed = await Promise.allSettled(
                  selected.map((f) => memdot.files.renew(f.id, { wait: false })),
                );
                const failed = renewed.filter((r) => r.status === "rejected");
                if (failed[0]?.status === "rejected")
                  toast.error(describeError(failed[0].reason).title);
                if (failed.length < renewed.length)
                  toast.success(`Renewing ${renewed.length - failed.length} file(s).`);
                await queryClient.invalidateQueries({ queryKey: ["jobs"] });
              }}
            >
              <RefreshCwIcon /> Renew
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="text-danger-fg"
              onClick={() => setDeleting(selected)}
            >
              <TrashIcon /> Delete
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Clear selection"
              onClick={() => setSelection({})}
            >
              <XIcon />
            </Button>
          </div>
        </div>
      )}

      {space && (
        <UploadSheet
          open={uploadOpen}
          onOpenChange={setUploadOpen}
          space={space}
          folderId={folderId}
          folderName={currentFolder?.name}
        />
      )}
      <FileSheet
        file={openFile}
        onOpenChange={(open) => !open && setOpenFile(null)}
        onShare={(file) => space && setShare({ kind: "file", file, space })}
        onRename={setRenaming}
        onDelete={(file) => setDeleting([file])}
        onOpenVersion={async (id) => {
          const info = await memdot.files.info(id);
          setOpenFile({ ...info, expiresAtBlock: null });
        }}
      />
      <ShareDialog target={share} onOpenChange={(open) => !open && setShare(null)} />
      <NameDialog
        open={newFolder}
        onOpenChange={setNewFolder}
        title="New folder"
        description="Its name is encrypted with the space key."
        label="Folder name"
        action="Create folder"
        onSubmit={async (name) => {
          await memdot.folders.create(spaceId, { name, parentId: folderId });
          await queryClient.invalidateQueries({ queryKey: ["folders", spaceId] });
        }}
      />
      <NameDialog
        open={renaming !== null}
        onOpenChange={(open) => !open && setRenaming(null)}
        title="Rename file"
        description="Only the sealed name changes; the stored bytes and CID stay the same."
        label="Name"
        initial={renaming?.name ?? ""}
        action="Rename"
        onSubmit={async (name) => {
          if (!renaming) return;
          const renamed = await memdot.files.rename(renaming.id, name);
          if (openFile?.id === renamed.id) setOpenFile({ ...openFile, name: renamed.name });
          await refresh();
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={
          deleting?.length === 1
            ? `Delete ${deleting[0]?.name ?? "this file"}?`
            : `Delete ${deleting?.length ?? 0} files?`
        }
        description="MemDot stops renewing it and frees the quota. The encrypted bytes leave the chain when their 7-day window ends."
        action="Delete"
        onConfirm={async () => {
          for (const file of deleting ?? []) await memdot.files.delete(file.id);
          setSelection({});
          if (openFile && deleting?.some((f) => f.id === openFile.id)) setOpenFile(null);
          await refresh();
        }}
      />
    </Page>
  );
}
