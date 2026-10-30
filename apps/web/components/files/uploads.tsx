"use client";

import type { FileInfo, Job } from "@memdot/sdk";
import { Button } from "@memdot/ui/components/button";
import { ChainProgress } from "@memdot/ui/components/chain-progress";
import { cn } from "@memdot/ui/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDownIcon, XIcon } from "lucide-react";
import { createContext, useCallback, useContext, useRef, useState } from "react";
import { describeError } from "@/lib/errors";
import { formatBytes } from "@/lib/format";
import { useMemDot } from "@/lib/memdot";

export interface Upload {
  id: string;
  name: string;
  size: number;
  spaceId: string;
  folderId: string | null;
  state: "waiting" | "storing" | "done" | "failed";
  job: Job | null;
  file: FileInfo | null;
  error: string | null;
}

interface UploadsValue {
  uploads: Upload[];
  /** Queues files; they are encrypted and stored one at a time (one relayer, one nonce line). */
  enqueue: (files: File[], target: { spaceId: string; folderId: string | null }) => void;
  clearFinished: () => void;
}

const UploadsContext = createContext<UploadsValue | null>(null);

export function useUploads(): UploadsValue {
  const value = useContext(UploadsContext);
  if (!value) throw new Error("useUploads must be used inside <UploadsProvider>");
  return value;
}

/**
 * Uploads outlive the sheet and the page: the queue lives with the shell, and a panel in the
 * corner keeps showing progress while you browse.
 */
export function UploadsProvider({ children }: { children: React.ReactNode }) {
  const memdot = useMemDot();
  const queryClient = useQueryClient();
  const [uploads, setUploads] = useState<Upload[]>([]);
  const pending = useRef<{ upload: Upload; file: File }[]>([]);
  const running = useRef(false);

  const patch = useCallback((id: string, next: Partial<Upload>) => {
    setUploads((list) => list.map((u) => (u.id === id ? { ...u, ...next } : u)));
  }, []);

  const drain = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    while (pending.current.length > 0) {
      const item = pending.current.shift();
      if (!item) break;
      const { upload, file } = item;
      patch(upload.id, { state: "storing" });
      try {
        const result = await memdot.files.put(new Uint8Array(await file.arrayBuffer()), {
          spaceId: upload.spaceId,
          ...(upload.folderId ? { folderId: upload.folderId } : {}),
          name: file.name,
          mime: file.type || "application/octet-stream",
          onProgress: (job) => patch(upload.id, { job }),
        });
        patch(upload.id, { state: "done", job: result.job, file: result.file });
      } catch (error) {
        patch(upload.id, { state: "failed", error: describeError(error).title });
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["files", upload.spaceId] }),
        queryClient.invalidateQueries({ queryKey: ["spaces"] }),
        queryClient.invalidateQueries({ queryKey: ["usage"] }),
        queryClient.invalidateQueries({ queryKey: ["jobs"] }),
      ]);
    }
    running.current = false;
  }, [memdot, patch, queryClient]);

  const enqueue = useCallback<UploadsValue["enqueue"]>(
    (files, target) => {
      const added = files.map((file) => ({
        upload: {
          id: crypto.randomUUID(),
          name: file.name,
          size: file.size,
          spaceId: target.spaceId,
          folderId: target.folderId,
          state: "waiting" as const,
          job: null,
          file: null,
          error: null,
        },
        file,
      }));
      pending.current.push(...added);
      setUploads((list) => [...added.map((a) => a.upload), ...list]);
      void drain();
    },
    [drain],
  );

  const clearFinished = useCallback(
    () => setUploads((list) => list.filter((u) => u.state === "waiting" || u.state === "storing")),
    [],
  );

  return (
    <UploadsContext value={{ uploads, enqueue, clearFinished }}>
      {children}
      <UploadsPanel />
    </UploadsContext>
  );
}

/** One upload's row: name, size and its way to the chain. */
export function UploadRow({ upload }: { upload: Upload }) {
  return (
    <li className="flex flex-col gap-1.5 border-b border-border px-3 py-2.5 last:border-0">
      <div className="flex items-center justify-between gap-3">
        <span className="truncate text-ui">{upload.name}</span>
        <span className="shrink-0 font-mono text-ui-sm text-text-3 tabular">
          {formatBytes(upload.size)}
        </span>
      </div>
      {upload.state === "waiting" ? (
        <span className="text-ui-sm text-text-3">Waiting</span>
      ) : upload.state === "failed" ? (
        <ChainProgress stage="failed" error={upload.error} />
      ) : (
        <ChainProgress
          stage={upload.job?.status ?? "running"}
          block={upload.job?.block}
          progress={upload.job?.progress}
        />
      )}
    </li>
  );
}

function UploadsPanel() {
  const { uploads, clearFinished } = useUploads();
  const [collapsed, setCollapsed] = useState(false);
  if (uploads.length === 0) return null;
  const active = uploads.filter((u) => u.state === "waiting" || u.state === "storing").length;

  return (
    <section
      aria-label="Uploads"
      className="fixed right-4 bottom-4 z-40 w-[min(360px,calc(100vw-2rem))] overflow-hidden rounded-xl border border-border-strong bg-popover shadow-overlay"
    >
      <header className="flex items-center justify-between gap-2 border-b border-border py-1.5 pr-1.5 pl-3">
        <span className="text-ui font-medium">
          {active > 0 ? `Storing ${active} file${active > 1 ? "s" : ""}` : "Uploads finished"}
        </span>
        <div className="flex items-center">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={collapsed ? "Expand" : "Collapse"}
            onClick={() => setCollapsed((c) => !c)}
          >
            <ChevronDownIcon className={cn("transition-transform", collapsed && "rotate-180")} />
          </Button>
          {active === 0 && (
            <Button variant="ghost" size="icon-sm" aria-label="Dismiss" onClick={clearFinished}>
              <XIcon />
            </Button>
          )}
        </div>
      </header>
      {!collapsed && (
        <ul className="max-h-72 overflow-y-auto">
          {uploads.map((upload) => (
            <UploadRow key={upload.id} upload={upload} />
          ))}
        </ul>
      )}
    </section>
  );
}
