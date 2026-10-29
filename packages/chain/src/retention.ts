import { ALERT_AT_FRACTION, RENEW_AT_FRACTION, RETENTION_BLOCKS } from "@memdot/config";

export type RetentionStatus = "fresh" | "renew-due" | "alert" | "expired";

export interface RetentionState {
  status: RetentionStatus;
  expiresAtBlock: number;
  remainingBlocks: number;
  fractionUsed: number;
}

export function renewDueAtBlock(storedAtBlock: number): number {
  return storedAtBlock + Math.floor(RETENTION_BLOCKS * RENEW_AT_FRACTION);
}

export function retentionState(storedAtBlock: number, headBlock: number): RetentionState {
  const expiresAtBlock = storedAtBlock + RETENTION_BLOCKS;
  const fractionUsed = (headBlock - storedAtBlock) / RETENTION_BLOCKS;
  const status: RetentionStatus =
    fractionUsed >= 1
      ? "expired"
      : fractionUsed >= ALERT_AT_FRACTION
        ? "alert"
        : fractionUsed >= RENEW_AT_FRACTION
          ? "renew-due"
          : "fresh";
  return { status, expiresAtBlock, remainingBlocks: expiresAtBlock - headBlock, fractionUsed };
}
