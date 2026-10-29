import { objects } from "@memdot/db";
import { failObject } from "@memdot/jobs";
import { and, eq, lt, sql } from "drizzle-orm";
import type { Deps } from "../deps.js";

/** The activity log keeps 30 days of request metadata (R10); older rows are deleted daily. */
const REQUEST_LOG_DAYS = 30;
/** Deleted in batches so no single statement or transaction runs long. */
const PRUNE_BATCH = 10_000;
/** A declared upload whose blobs never all arrived is abandoned after a day. */
const ABANDONED_UPLOAD_HOURS = 24;
const MAX_ABANDONED_PER_RUN = 500;
const HOUR_MS = 60 * 60 * 1000;

export async function maintenance(deps: Deps): Promise<void> {
  const pruned = await pruneRequestLog(deps);
  const abandoned = await expireAbandonedUploads(deps);
  console.log(
    `[maintenance] pruned ${pruned} request log rows, expired ${abandoned} abandoned uploads`,
  );
}

async function pruneRequestLog(deps: Deps): Promise<number> {
  const cutoff = new Date(Date.now() - REQUEST_LOG_DAYS * 24 * HOUR_MS);
  let total = 0;
  for (;;) {
    const result = await deps.db.execute(sql`
      delete from request_logs where id in (
        select id from request_logs where created_at < ${cutoff} limit ${PRUNE_BATCH}
      )`);
    total += result.rowCount ?? 0;
    if ((result.rowCount ?? 0) < PRUNE_BATCH) return total;
  }
}

/**
 * Objects still waiting for their blobs a day after they were declared: the client is gone. They
 * fail like any other upload: quota returned, staged ciphertext dropped, the job closed.
 */
async function expireAbandonedUploads(deps: Deps): Promise<number> {
  const cutoff = new Date(Date.now() - ABANDONED_UPLOAD_HOURS * HOUR_MS);
  const stale = await deps.db
    .select({ id: objects.id })
    .from(objects)
    .where(and(eq(objects.status, "queued"), lt(objects.createdAt, cutoff)))
    .limit(MAX_ABANDONED_PER_RUN);
  let expired = 0;
  for (const object of stale) {
    const failed = await deps.db.transaction((tx) =>
      failObject(tx, object.id, "The upload was never completed; its reserved quota was released."),
    );
    if (failed) expired += 1;
  }
  return expired;
}
