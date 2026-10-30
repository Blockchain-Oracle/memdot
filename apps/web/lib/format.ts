import { TPOT_DECIMALS } from "@memdot/config";

const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;
const KIB = 1024;

/** 1,536 → "1.5 KB" (binary steps, short labels). */
export function formatBytes(bytes: number, fractionDigits = 1): string {
  if (bytes < KIB) return `${bytes} B`;
  let value = bytes;
  let unit = 0;
  while (value >= KIB && unit < UNITS.length - 1) {
    value /= KIB;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : fractionDigits)} ${UNITS[unit]}`;
}

export const formatNumber = (value: number) => value.toLocaleString("en-US");

const RELATIVE = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

const RELATIVE_SHORT = new Intl.RelativeTimeFormat("en", { numeric: "auto", style: "narrow" });

/** "3 minutes ago", "in 2 days"; `short` gives "3m ago" for dense tables. */
export function formatRelative(date: string | Date, short = false): string {
  const seconds = (new Date(date).getTime() - Date.now()) / 1000;
  const format = short ? RELATIVE_SHORT : RELATIVE;
  for (const [unit, size] of STEPS) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

/** Local and UTC, for timestamp tooltips. */
export function formatDualTime(date: string | Date): { local: string; utc: string } {
  const d = new Date(date);
  return {
    local: d.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }),
    utc: `${d.toISOString().replace("T", " ").slice(0, 16)} UTC`,
  };
}

export const TPOT_SHOWN_DIGITS = 4;

/** Planck (14 decimals) to tPOT as a number, exact to the digits shown. */
export function planckToTpot(planck: string | bigint): number {
  const scale = 10n ** BigInt(TPOT_DECIMALS - TPOT_SHOWN_DIGITS);
  return Number(BigInt(planck) / scale) / 10 ** TPOT_SHOWN_DIGITS;
}
