import { BLOCK_MS } from "@memdot/config";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Blocks from now as a short duration: "5d 2h", "3h 10m", "45m". */
export function blocksToDuration(blocks: number): string {
  const ms = Math.max(0, blocks) * BLOCK_MS;
  const days = Math.floor(ms / DAY_MS);
  const hours = Math.floor((ms % DAY_MS) / HOUR_MS);
  const minutes = Math.floor((ms % HOUR_MS) / MINUTE_MS);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
