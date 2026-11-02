"use client";

import { TINY_FILE_BYTES } from "@memdot/config";
import { formatTpot, type Space } from "@memdot/sdk";
import { Button } from "@memdot/ui/components/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@memdot/ui/components/sheet";
import { cn } from "@memdot/ui/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { BrainIcon, LockIcon, TrashIcon, UploadIcon } from "lucide-react";
import { useState } from "react";
import { useDropzone } from "react-dropzone";
import { toast } from "sonner";
import { READ_NOTICE } from "@/components/memory/remember-file";
import { describeError, isCancelled } from "@/lib/errors";
import { formatBytes } from "@/lib/format";
import { useMemDot } from "@/lib/memdot";
import { FileTypeIcon } from "./file-icon";
import { linkWalletIfNone, SigningWallet, useWalletBalance } from "./signing-wallet";
import { useUploads } from "./uploads";

/**
 * Pick files, see what storing them costs on V3 and who pays, then store. Built on
 * ephraimduncan/file-upload-03 (21st.dev): a dropzone over a removable file list.
 */
export function UploadSheet({
  open,
  onOpenChange,
  space,
  folderId,
  folderName,
  memoryMode,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  space: Space;
  folderId: string | null;
  folderName?: string | null;
  /** A memory folder: what's stored here is also read for memories. */
  memoryMode?: "off" | "private" | "assisted" | undefined;
}) {
  const memdot = useMemDot();
  const queryClient = useQueryClient();
  const { enqueue, wallet, setWallet } = useUploads();
  const { data: walletFree } = useWalletBalance(wallet);
  const [files, setFiles] = useState<File[]>([]);
  const [switching, setSwitching] = useState(false);
  const [busy, setBusy] = useState(false);
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: (accepted) =>
      setFiles((current) => [
        ...current,
        ...accepted.filter((a) => !current.some((c) => c.name === a.name && c.size === a.size)),
      ]),
  });

  const total = files.reduce((sum, f) => sum + f.size, 0);
  const estimates = files.map((f) => memdot.files.estimate(f.size));
  // Small files share one segment, so they cost one store between them.
  const tinyBytes = files
    .filter((f) => f.size <= TINY_FILE_BYTES)
    .reduce((sum, f) => sum + f.size, 0);
  const shared = tinyBytes > 0 ? memdot.files.estimate(tinyBytes) : { blobs: 0, planck: 0n };
  const large = estimates.filter((_, i) => (files[i]?.size ?? 0) > TINY_FILE_BYTES);
  const blobs = shared.blobs + large.reduce((sum, e) => sum + e.blobs, 0);
  const planck = shared.planck + large.reduce((sum, e) => sum + e.planck, 0n);
  const free = Math.max(0, space.quotaBytes - space.usedBytes);
  const sponsored = space.mode === "sponsored";
  const overQuota = sponsored && total > free;
  const walletReady = sponsored || (wallet !== null && (walletFree ?? 0n) >= planck);

  const reading = memoryMode === "private" || memoryMode === "assisted";

  const store = () => {
    enqueue(files, {
      spaceId: space.id,
      folderId,
      ...(!sponsored && wallet ? { wallet } : {}),
      ...(reading && folderId ? { rememberIn: folderId } : {}),
    });
    setFiles([]);
    onOpenChange(false);
  };

  // Over the sponsored quota, the way forward is paying for it yourself.
  const payWithWallet = async () => {
    if (!wallet) return;
    setBusy(true);
    try {
      await linkWalletIfNone(memdot, wallet);
      await memdot.spaces.setMode(space.id, "self_signed");
      await queryClient.invalidateQueries({ queryKey: ["spaces"] });
      setSwitching(false);
    } catch (error) {
      if (!isCancelled(error)) toast.error(describeError(error).title);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-[520px]">
        <SheetHeader className="border-b border-border p-5">
          <SheetTitle className="text-h2">Upload files</SheetTitle>
          <SheetDescription>
            To {space.name ?? "this space"}
            {folderName ? ` / ${folderName}` : ""}. Encrypted on this device before anything leaves
            it.
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-1 flex-col gap-5 overflow-y-auto p-5 [&>*]:shrink-0">
          {reading && (
            <p className="flex items-start gap-2 rounded-lg border border-border bg-surface-1 p-3 text-ui-sm text-text-2">
              <BrainIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              {READ_NOTICE[memoryMode]}
            </p>
          )}
          <div
            {...getRootProps()}
            className={cn(
              "flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed border-border-strong bg-surface-1 px-6 py-10 text-center outline-none transition-colors duration-(--motion-instant) hover:bg-surface-2 focus-visible:ring-3 focus-visible:ring-ring/50",
              isDragActive && "border-foreground bg-surface-2",
            )}
          >
            <input {...getInputProps()} />
            <UploadIcon className="size-5 text-text-3" aria-hidden="true" />
            <span className="text-ui">
              {isDragActive ? "Drop to add" : "Drop files or click to choose"}
            </span>
            <span className="flex items-center gap-1.5 text-ui-sm text-text-3">
              <LockIcon className="size-3.5" aria-hidden="true" />
              {sponsored
                ? `${formatBytes(free)} left on the sponsored quota`
                : "Your wallet signs each store"}
            </span>
          </div>

          {files.length > 0 && (
            <ul className="flex flex-col overflow-hidden rounded-xl border border-border bg-surface-1">
              {files.map((file, i) => (
                <li
                  key={`${file.name}:${file.size}`}
                  className="flex items-center gap-3 border-b border-border px-3 py-2.5 last:border-0"
                >
                  <FileTypeIcon mime={file.type} name={file.name} />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-ui">{file.name}</span>
                    <span className="font-mono text-ui-sm text-text-3 tabular">
                      {formatBytes(file.size)} ·{" "}
                      {file.size <= TINY_FILE_BYTES
                        ? "shared segment"
                        : `${estimates[i]?.blobs ?? 1} blobs`}
                    </span>
                  </span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${file.name}`}
                    onClick={() => setFiles((list) => list.filter((f) => f !== file))}
                  >
                    <TrashIcon />
                  </Button>
                </li>
              ))}
            </ul>
          )}

          {!sponsored && (
            <SigningWallet
              wallet={wallet}
              onChange={setWallet}
              {...(files.length > 0 ? { needs: planck } : {})}
            />
          )}

          {files.length > 0 && (
            <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border font-mono text-ui-sm">
              {[
                ["Size", formatBytes(total)],
                ["Blobs on chain", String(blobs)],
                ["Store fee", `≈ ${formatTpot(planck)}`],
                ["Paid by", sponsored ? "MemDot (sponsored)" : "Your wallet"],
              ].map(([label, value]) => (
                <div key={label} className="flex flex-col gap-1 bg-surface-1 p-3">
                  <dt className="eyebrow">{label}</dt>
                  <dd className="text-foreground tabular">{value}</dd>
                </div>
              ))}
            </dl>
          )}
          {files.length > 0 && (
            <p className="text-ui-sm text-text-3">
              Files under 64 KB share one encrypted segment: one blob on chain, renewed together.
              The keeper renews everything before the 7-day window ends.
            </p>
          )}
          {overQuota && (
            <p className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-ui-sm text-danger-fg">
              That is {formatBytes(total - free)} more than this space has left. Remove some files,
              or{" "}
              <button
                type="button"
                className="underline underline-offset-2"
                onClick={() => setSwitching(true)}
              >
                pay with your wallet
              </button>{" "}
              from now on.
            </p>
          )}
          {overQuota && switching && (
            <div className="flex flex-col gap-3">
              <SigningWallet wallet={wallet} onChange={setWallet} needs={planck} />
              <Button disabled={!wallet || busy} onClick={payWithWallet}>
                Use this wallet for this space
              </Button>
            </div>
          )}
        </div>

        <SheetFooter className="flex-row justify-end gap-2 border-t border-border p-4">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={files.length === 0 || overQuota || !walletReady} onClick={store}>
            {files.length === 0
              ? "Store"
              : `Store ${files.length} file${files.length > 1 ? "s" : ""} · ≈ ${formatTpot(planck)}`}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
