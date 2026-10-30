import { cn } from "../lib/utils";

export type RetentionState = "ok" | "warn" | "lost" | "pending";

const CELLS = 7;

/**
 * The 7-day retention window as the banner's grid of cells: one cell per day. Remaining days are
 * filled, elapsed days outlined; the last fifth turns warn; lost is all outlined in danger.
 */
export function RetentionMeter({
  remaining,
  state,
  className,
}: {
  /** Share of the window left, 0..1. */
  remaining: number;
  state: RetentionState;
  className?: string;
}) {
  const filled = state === "lost" ? 0 : Math.ceil(Math.max(0, Math.min(1, remaining)) * CELLS);
  return (
    <span
      role="img"
      aria-label={
        state === "lost"
          ? "Lost from the chain"
          : state === "pending"
            ? "Not on chain yet"
            : `${filled} of ${CELLS} days left`
      }
      className={cn("inline-flex gap-0.5", className)}
    >
      {Array.from({ length: CELLS }, (_, i) => (
        <span
          key={i}
          className={cn(
            "size-2 rounded-xs border transition-colors duration-(--motion-state)",
            state === "pending" && "animate-pulse border-border-strong bg-transparent",
            state === "lost" && "border-danger/60 bg-transparent",
            state !== "pending" &&
              state !== "lost" &&
              (i < filled
                ? state === "warn"
                  ? "border-transparent bg-warn"
                  : "border-transparent bg-foreground/80"
                : "border-border-strong bg-transparent"),
          )}
          style={i < filled ? { transitionDelay: `${i * 30}ms` } : undefined}
        />
      ))}
    </span>
  );
}
