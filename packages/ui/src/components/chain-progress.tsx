import { cn } from "../lib/utils";

export type ChainStage = "queued" | "running" | "submitted" | "in_block" | "finalized" | "failed";

const FILLED: Record<ChainStage, number> = {
  queued: 0,
  running: 0,
  submitted: 1,
  in_block: 2,
  finalized: 3,
  failed: 0,
};

const BARS = [
  { y: 1, w: 100 },
  { y: 8, w: 76 },
  { y: 15, w: 52 },
];

/**
 * A transaction as the brand mark: submitted fills bar 1, in block fills bar 2, finalized fills
 * bar 3 and the ember dot pops in. The same glyph inline, in the tx tray and in dialogs.
 */
export function ChainProgressGlyph({
  stage,
  className,
}: {
  stage: ChainStage;
  className?: string;
}) {
  const filled = FILLED[stage];
  const pending = stage === "queued" || stage === "running";
  return (
    <svg
      viewBox="0 0 34 20"
      aria-hidden="true"
      className={cn("h-3.5 w-6 shrink-0", stage === "failed" && "text-danger", className)}
    >
      {BARS.map((bar, i) => (
        <rect
          key={bar.y}
          x="0"
          y={bar.y}
          width={(bar.w / 100) * 22}
          height="4"
          rx="2"
          className={cn(
            "transition-[fill] duration-(--motion-state)",
            i < filled ? "fill-foreground" : "fill-border-strong",
            pending && i === 0 && "animate-pulse",
            stage === "failed" && "fill-danger/40",
          )}
        />
      ))}
      {stage === "finalized" && (
        <circle
          cx="29"
          cy="10"
          r="4"
          fill="var(--md-ember)"
          className="animate-dot-pop"
          style={{ transformBox: "fill-box", transformOrigin: "center" }}
        />
      )}
    </svg>
  );
}

const LABEL: Record<ChainStage, string> = {
  queued: "Queued",
  running: "Encrypting and sending",
  submitted: "Submitted",
  in_block: "In block",
  finalized: "Finalized",
  failed: "Failed",
};

/** The glyph plus words: "In block #241,203" / "Finalized" / "2 of 3 blobs". */
export function ChainProgress({
  stage,
  block,
  progress,
  error,
  className,
}: {
  stage: ChainStage;
  block?: number | null;
  progress?: { done: number; total: number } | null;
  error?: string | null;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn("inline-flex items-center gap-2 text-ui-sm", className)}
    >
      <ChainProgressGlyph stage={stage} />
      <span className={cn(stage === "failed" ? "text-danger-fg" : "text-text-2")}>
        {LABEL[stage]}
        {(stage === "in_block" || stage === "finalized") && block ? (
          <span className="font-mono tabular text-text-3"> #{block.toLocaleString("en-US")}</span>
        ) : null}
        {progress && progress.total > 1 && stage !== "finalized" ? (
          <span className="font-mono tabular text-text-3">
            {" "}
            · {progress.done}/{progress.total}
          </span>
        ) : null}
        {stage === "failed" && error ? <span className="text-text-3"> · {error}</span> : null}
      </span>
    </div>
  );
}
