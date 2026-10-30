"use client";

import { SPONSORED_QUOTA_BYTES } from "@memdot/config";
import { type FileInfo, formatTpot, type Job, type VerifyResult } from "@memdot/sdk";
import { Button } from "@memdot/ui/components/button";
import { ChainProgress } from "@memdot/ui/components/chain-progress";
import { CidText } from "@memdot/ui/components/cid-text";
import { Spinner } from "@memdot/ui/components/spinner";
import { cn } from "@memdot/ui/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { CircleCheckIcon, CircleXIcon, ShieldCheckIcon, UploadIcon } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { describeError } from "@/lib/errors";
import { formatBytes, formatNumber } from "@/lib/format";
import { useMemDot } from "@/lib/memdot";
import { StepFrame } from "./step-frame";

/** Step 5: a real file goes through the real pipeline, then this browser verifies it on chain. */
export function StepFirstFile({ spaceId, onDone }: { spaceId: string; onDone: () => void }) {
  const memdot = useMemDot();
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [picked, setPicked] = useState<File | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [stored, setStored] = useState<FileInfo | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verified, setVerified] = useState<VerifyResult | null>(null);

  const store = async (file: File) => {
    if (file.size > SPONSORED_QUOTA_BYTES) {
      toast.error(
        `Sponsored spaces hold ${formatBytes(SPONSORED_QUOTA_BYTES)}. Pick a smaller file.`,
      );
      return;
    }
    setPicked(file);
    setJob(null);
    try {
      const result = await memdot.files.put(new Uint8Array(await file.arrayBuffer()), {
        spaceId,
        name: file.name,
        mime: file.type || "application/octet-stream",
        onProgress: setJob,
      });
      setJob(result.job);
      setStored(result.file);
      await queryClient.invalidateQueries({ queryKey: ["files", spaceId] });
    } catch (error) {
      toast.error(describeError(error).title);
      setPicked(null);
    }
  };

  const estimate = picked ? memdot.files.estimate(picked.size) : null;
  const block = verified?.blobs.find((b) => b.block !== null)?.block ?? job?.block ?? null;

  return (
    <StepFrame
      title="Store your first file"
      description="It is encrypted here, then stored on Portaldot by MemDot's relayer. Then this browser checks it on chain, without asking MemDot."
      actions={
        stored ? (
          <Button size="lg" onClick={onDone}>
            Finish
          </Button>
        ) : (
          <Button variant="ghost" size="lg" onClick={onDone} disabled={picked !== null}>
            Skip for now
          </Button>
        )
      }
    >
      {!picked ? (
        <button
          type="button"
          onClick={() => input.current?.click()}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            const file = event.dataTransfer.files[0];
            if (file) void store(file);
          }}
          className={cn(
            "flex flex-col items-center gap-2 rounded-xl border border-dashed border-border-strong bg-surface-1 px-6 py-10 text-center outline-none transition-colors duration-(--motion-instant) hover:bg-surface-2 focus-visible:ring-3 focus-visible:ring-ring/50",
            dragging && "border-foreground bg-surface-2",
          )}
        >
          <UploadIcon className="size-5 text-text-3" aria-hidden="true" />
          <span className="text-ui text-foreground">Drop a file or choose one</span>
          <span className="text-ui-sm text-text-3">
            Up to {formatBytes(SPONSORED_QUOTA_BYTES)} on the sponsored quota
          </span>
          <input
            ref={input}
            type="file"
            className="sr-only"
            tabIndex={-1}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void store(file);
            }}
          />
        </button>
      ) : (
        <div className="flex flex-col gap-4 rounded-xl border border-border bg-surface-1 p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-ui text-foreground">{picked.name}</span>
              <span className="font-mono text-ui-sm text-text-3 tabular">
                {formatBytes(picked.size)}
                {estimate &&
                  ` · ${estimate.blobs} blob${estimate.blobs > 1 ? "s" : ""} · ≈ ${formatTpot(estimate.planck)} · sponsored`}
              </span>
            </div>
          </div>
          <ChainProgress
            stage={job?.status ?? "queued"}
            block={job?.block}
            progress={job?.progress}
            error={job?.error}
          />
          {stored && (
            <div className="flex flex-col gap-3 border-t border-border pt-4">
              {(verified?.blobs[0]?.cid ?? stored.cid) && (
                <div className="flex items-center justify-between gap-3">
                  <span className="eyebrow">{stored.segmentId ? "Segment CID" : "CID"}</span>
                  <CidText value={verified?.blobs[0]?.cid ?? stored.cid ?? ""} />
                </div>
              )}
              {stored.segmentId && !verified && (
                <p className="text-ui-sm text-text-3">
                  Small files are packed into one encrypted segment: one blob on chain, renewed
                  together.
                </p>
              )}
              {verified ? (
                <p
                  className={cn(
                    "flex items-center gap-2 text-ui-sm",
                    verified.ok ? "text-ok-fg" : "text-danger-fg",
                  )}
                >
                  {verified.ok ? (
                    <CircleCheckIcon className="size-4" aria-hidden="true" />
                  ) : (
                    <CircleXIcon className="size-4" aria-hidden="true" />
                  )}
                  {verified.ok
                    ? `Hash matches · on chain in block #${block ? formatNumber(block) : "?"}`
                    : "This file did not verify. The bytes or the chain record do not match."}
                </p>
              ) : (
                <Button
                  variant="outline"
                  disabled={verifying}
                  onClick={async () => {
                    setVerifying(true);
                    try {
                      setVerified(await memdot.files.verify(stored.id));
                    } catch (error) {
                      toast.error(describeError(error).title);
                    } finally {
                      setVerifying(false);
                    }
                  }}
                >
                  {verifying ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <ShieldCheckIcon data-icon="inline-start" />
                  )}
                  Verify on Portaldot
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </StepFrame>
  );
}
