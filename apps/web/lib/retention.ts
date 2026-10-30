import { RENEW_AT_FRACTION, RETENTION_BLOCKS } from "@memdot/config";
import type { RetentionState } from "@memdot/ui/components/retention-meter";

/** Design: the last fifth of the window is shown as a warning. */
const WARN_FRACTION = 0.2;

export interface Retention {
  state: RetentionState;
  /** Share of the 7-day window left, 0..1. */
  remaining: number;
  blocksLeft: number | null;
  /** Past its window: still served from MemDot's cache while the keeper stores it again. */
  expired: boolean;
  /** Where the keeper renews it (80% of the window). */
  renewAtBlock: number | null;
}

/** Lost is decided by the object's status; an expired window alone is a warning. */
export function retentionOf(
  expiresAtBlock: number | null,
  headBlock: number | null,
  lost = false,
): Retention {
  if (lost) {
    return { state: "lost", remaining: 0, blocksLeft: null, expired: true, renewAtBlock: null };
  }
  if (expiresAtBlock === null || headBlock === null) {
    return { state: "pending", remaining: 0, blocksLeft: null, expired: false, renewAtBlock: null };
  }
  const blocksLeft = expiresAtBlock - headBlock;
  const remaining = blocksLeft / RETENTION_BLOCKS;
  const storedAt = expiresAtBlock - RETENTION_BLOCKS;
  return {
    state: remaining <= WARN_FRACTION ? "warn" : "ok",
    remaining,
    blocksLeft,
    expired: blocksLeft <= 0,
    renewAtBlock: storedAt + Math.floor(RETENTION_BLOCKS * RENEW_AT_FRACTION),
  };
}
