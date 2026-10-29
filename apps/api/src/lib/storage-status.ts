import { opsAlerts } from "@memdot/db";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db.js";

/** The worker's breaker state changes rarely; one read per this window is plenty. */
const CACHE_MS = 30_000;

let cached: { paused: boolean; at: number } | null = null;

/**
 * Whether sponsored storage is paused because the relayer is low on tPOT (the worker raised an
 * unresolved `low_balance` alert). New sponsored uploads are refused meanwhile, with a reason,
 * instead of waiting in the queue for an unknown time.
 */
export async function sponsoredStoragePaused(now = Date.now()): Promise<boolean> {
  if (cached && now - cached.at < CACHE_MS) return cached.paused;
  const [open] = await db
    .select({ id: opsAlerts.id })
    .from(opsAlerts)
    .where(and(eq(opsAlerts.kind, "low_balance"), isNull(opsAlerts.resolvedAt)))
    .limit(1);
  cached = { paused: !!open, at: now };
  return cached.paused;
}
