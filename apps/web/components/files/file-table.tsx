// biome-ignore-all lint/a11y/useSemanticElements: virtualized rows are absolutely positioned, so the table is ARIA roles on divs (the TanStack Virtual pattern)
// biome-ignore-all lint/a11y/useFocusableInteractive: header and cell roles are not interactive; rows carry tabIndex
"use client";

import type { Folder, ListedFile } from "@memdot/sdk";
import { Checkbox } from "@memdot/ui/components/checkbox";
import { middleEllipsis } from "@memdot/ui/components/cid-text";
import { RetentionMeter } from "@memdot/ui/components/retention-meter";
import { Status, StatusIndicator, StatusLabel } from "@memdot/ui/components/status";
import { Tooltip, TooltipContent, TooltipTrigger } from "@memdot/ui/components/tooltip";
import { cn } from "@memdot/ui/lib/utils";
import {
  createColumnHelper,
  createSortedRowModel,
  type RowSelectionState,
  rowSelectionFeature,
  rowSortingFeature,
  type SortingState,
  sortFn_alphanumeric,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { useWindowVirtualizer } from "@tanstack/react-virtual";
import { ArrowDownIcon, ArrowUpIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { formatBytes, formatDualTime, formatRelative } from "@/lib/format";
import { type Retention, retentionOf } from "@/lib/retention";
import { blocksToDuration } from "@/lib/time";
import { FileTypeIcon } from "./file-icon";

export type FileRow =
  | { kind: "folder"; id: string; name: string | null; folder: Folder; size: null; updated: string }
  | {
      kind: "file";
      id: string;
      name: string | null;
      file: ListedFile;
      size: number;
      updated: string;
    };

const features = tableFeatures({
  rowSortingFeature,
  rowSelectionFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric },
});
const helper = createColumnHelper<typeof features, FileRow>();
const ROW_HEIGHT = 44;
/** Phones: name, size, status. md: + renewal and updated. xl: + CID. */
const GRID =
  "grid grid-cols-[28px_minmax(0,1fr)_64px_96px] items-center gap-x-3 md:grid-cols-[28px_minmax(0,1fr)_64px_96px_116px_88px] xl:grid-cols-[28px_minmax(0,1fr)_72px_140px_100px_120px_96px]";

/** Folders always sort above files, whichever column sorts. */
const foldersFirst = (a: FileRow, b: FileRow) =>
  a.kind === b.kind ? 0 : a.kind === "folder" ? -1 : 1;

const columns = helper.columns([
  helper.accessor("name", {
    id: "name",
    header: "Name",
    sortFn: (a, b) =>
      foldersFirst(a.original, b.original) ||
      (a.original.name ?? "").localeCompare(b.original.name ?? "", undefined, { numeric: true }),
  }),
  helper.accessor("size", {
    id: "size",
    header: "Size",
    sortFn: (a, b) =>
      foldersFirst(a.original, b.original) || (a.original.size ?? 0) - (b.original.size ?? 0),
  }),
  helper.accessor("updated", {
    id: "updated",
    header: "Updated",
    sortFn: (a, b) =>
      foldersFirst(a.original, b.original) ||
      new Date(a.original.updated).getTime() - new Date(b.original.updated).getTime(),
  }),
]);

const STATUS: Record<
  ListedFile["status"],
  { variant: "default" | "ok" | "warn" | "danger" | "live"; label: string; pulse?: boolean }
> = {
  queued: { variant: "live", label: "Queued", pulse: true },
  uploading: { variant: "live", label: "Storing", pulse: true },
  stored: { variant: "ok", label: "Stored" },
  failed: { variant: "danger", label: "Failed" },
  tombstoned: { variant: "default", label: "Deleted" },
  lost: { variant: "danger", label: "Lost" },
};

export function FileStatus({ file, retention }: { file: ListedFile; retention: Retention }) {
  const base = STATUS[file.status];
  const status =
    file.status === "stored" && retention.expired
      ? { variant: "warn" as const, label: "Re-storing", pulse: true }
      : file.status === "stored" && retention.state === "warn"
        ? { variant: "warn" as const, label: "Expiring" }
        : base;
  return (
    <Status variant={status.variant}>
      <StatusIndicator pulse={status.pulse} />
      <StatusLabel>{status.label}</StatusLabel>
    </Status>
  );
}

export function FileTable({
  rows,
  headBlock,
  selection,
  onSelectionChange,
  onOpenFile,
  onOpenFolder,
}: {
  rows: FileRow[];
  headBlock: number | null;
  selection: RowSelectionState;
  onSelectionChange: (next: RowSelectionState) => void;
  onOpenFile: (file: ListedFile) => void;
  onOpenFolder: (folder: Folder) => void;
}) {
  const [sorting, setSorting] = useState<SortingState>([{ id: "updated", desc: true }]);
  const table = useTable({
    features,
    columns,
    data: rows,
    getRowId: (row) => row.id,
    enableRowSelection: (row) => row.original.kind === "file",
    state: { sorting, rowSelection: selection },
    onSortingChange: setSorting,
    onRowSelectionChange: (updater) =>
      onSelectionChange(typeof updater === "function" ? updater(selection) : updater),
  });
  const modelRows = table.getRowModel().rows;

  const listRef = useRef<HTMLDivElement>(null);
  const [offset, setOffset] = useState(0);
  useLayoutEffect(() => {
    setOffset(listRef.current?.offsetTop ?? 0);
  }, []);
  const virtualizer = useWindowVirtualizer({
    count: modelRows.length,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
    scrollMargin: offset,
    getItemKey: (index) => modelRows[index]?.id ?? index,
  });

  const sortHeader = (id: "name" | "size" | "updated", label: string, className?: string) => {
    const column = table.getColumn(id);
    const dir = column?.getIsSorted();
    return (
      <button
        type="button"
        onClick={column?.getToggleSortingHandler()}
        className={cn("inline-flex items-center gap-1 hover:text-foreground", className)}
      >
        {label}
        {dir === "asc" && <ArrowUpIcon className="size-3" />}
        {dir === "desc" && <ArrowDownIcon className="size-3" />}
      </button>
    );
  };

  const fileRows = modelRows.filter((r) => r.original.kind === "file");
  const allSelected = fileRows.length > 0 && fileRows.every((r) => selection[r.id]);
  const someSelected = fileRows.some((r) => selection[r.id]);

  return (
    <div role="table" aria-label="Files" className="rounded-xl border border-border bg-surface-1">
      <div
        role="row"
        className={cn(
          GRID,
          "h-9 border-b border-border px-3 font-mono text-label text-text-3 uppercase",
        )}
      >
        <span role="columnheader">
          <Checkbox
            aria-label="Select all files"
            checked={allSelected ? true : someSelected ? "indeterminate" : false}
            onCheckedChange={(value) =>
              onSelectionChange(
                value === true ? Object.fromEntries(fileRows.map((r) => [r.id, true])) : {},
              )
            }
          />
        </span>
        <span role="columnheader">{sortHeader("name", "Name")}</span>
        <span role="columnheader" className="text-right">
          {sortHeader("size", "Size", "justify-end")}
        </span>
        <span role="columnheader" className="hidden xl:block">
          CID
        </span>
        <span role="columnheader">Status</span>
        <span role="columnheader" className="hidden md:block">
          Renewal
        </span>
        <span role="columnheader" className="hidden text-right md:block">
          {sortHeader("updated", "Updated", "justify-end")}
        </span>
      </div>
      <div ref={listRef} className="relative" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = modelRows[item.index];
          if (!row) return null;
          const entry = row.original;
          const style = {
            position: "absolute" as const,
            top: 0,
            left: 0,
            width: "100%",
            height: item.size,
            transform: `translateY(${item.start - virtualizer.options.scrollMargin}px)`,
          };
          if (entry.kind === "folder") {
            return (
              <div
                key={row.id}
                role="row"
                tabIndex={0}
                style={style}
                onClick={() => onOpenFolder(entry.folder)}
                onKeyDown={(e) => e.key === "Enter" && onOpenFolder(entry.folder)}
                className={cn(
                  GRID,
                  "cursor-pointer border-b border-border px-3 outline-none last:border-0 hover:bg-surface-2 focus-visible:bg-surface-2",
                )}
              >
                <span />
                <span role="cell" className="flex min-w-0 items-center gap-2.5">
                  <FileTypeIcon folder />
                  <span className="truncate text-ui">{entry.name ?? "Encrypted folder"}</span>
                </span>
                <span role="cell" className="text-right text-ui-sm text-text-4">
                  —
                </span>
                <span className="hidden xl:block" />
                <span role="cell" className="text-ui-sm text-text-3">
                  Folder
                </span>
                <span className="hidden md:block" />
                <span role="cell" className="hidden text-right text-ui-sm text-text-3 md:block">
                  {formatRelative(entry.updated)}
                </span>
              </div>
            );
          }
          const file = entry.file;
          const retention = retentionOf(file.expiresAtBlock, headBlock, file.status === "lost");
          const time = formatDualTime(file.createdAt);
          const selected = Boolean(selection[row.id]);
          return (
            <div
              key={row.id}
              role="row"
              tabIndex={0}
              aria-selected={selected}
              style={style}
              onClick={() => onOpenFile(file)}
              onKeyDown={(e) => e.key === "Enter" && onOpenFile(file)}
              className={cn(
                GRID,
                "cursor-pointer border-b border-border px-3 outline-none last:border-0 hover:bg-surface-2 focus-visible:bg-surface-2",
                selected && "bg-surface-3 hover:bg-surface-3",
              )}
            >
              <span
                role="cell"
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
              >
                <Checkbox
                  aria-label={`Select ${file.name ?? "file"}`}
                  checked={selected}
                  onClick={row.getToggleSelectedHandler()}
                />
              </span>
              <span role="cell" className="flex min-w-0 items-center gap-2.5">
                <FileTypeIcon mime={file.mime} name={file.name} />
                <span className="truncate text-ui">{file.name ?? "Encrypted file"}</span>
              </span>
              <span role="cell" className="text-right font-mono text-ui-sm text-text-2 tabular">
                {file.size !== null ? formatBytes(file.size) : "—"}
              </span>
              <span
                role="cell"
                className="hidden truncate font-mono text-ui-sm text-text-2 xl:block"
              >
                {file.cid ? middleEllipsis(file.cid) : file.segmentId ? "in segment" : "—"}
              </span>
              <span role="cell">
                <FileStatus file={file} retention={retention} />
              </span>
              <span role="cell" className="hidden items-center gap-2 md:flex">
                <RetentionMeter remaining={retention.remaining} state={retention.state} />
                {retention.blocksLeft !== null && retention.blocksLeft > 0 && (
                  <span className="font-mono text-ui-sm whitespace-nowrap text-text-3 tabular">
                    {blocksToDuration(retention.blocksLeft)}
                  </span>
                )}
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    role="cell"
                    className="hidden truncate text-right text-ui-sm text-text-3 md:block"
                  >
                    {formatRelative(file.createdAt, true)}
                  </span>
                </TooltipTrigger>
                <TooltipContent side="left" className="font-mono text-[12px]">
                  {time.local} · {time.utc}
                </TooltipContent>
              </Tooltip>
            </div>
          );
        })}
      </div>
    </div>
  );
}
