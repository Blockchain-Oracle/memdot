import { blobStaging, jobs, objects, requestLogs, spaces, storedItems } from "@memdot/db";
import { JOB_KIND, updateJob } from "@memdot/jobs";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import type { Deps } from "../deps.js";

/** The activity log keeps 30 days of request metadata (R10); older rows are deleted daily. */
const REQUEST_LOG_DAYS = 30;
/** A declared upload whose blobs never all arrived is abandoned after a day. */
const ABANDONED_UPLOAD_HOURS = 24;
const MAX_ABANDONED_PER_RUN = 500;
const HOUR_MS = 60 * 60 * 1000;

export async function maintenance(deps: Deps): Promise<void> {
  const logCutoff = new Date(Date.now() - REQUEST_LOG_DAYS * 24 * HOUR_MS);
  const pruned = await deps.db
    .delete(requestLogs)
    .where(lt(requestLogs.createdAt, logCutoff))
    .returning({ id: requestLogs.id });

  const abandoned = await expireAbandonedUploads(deps);
  console.log(
    `[maintenance] pruned ${pruned.length} request log rows, expired ${abandoned} abandoned uploads`,
  );
}

/**
 * Objects still waiting for their blobs a day after they were declared: the client is gone. They
 * are marked failed, their reserved quota is returned and their staged ciphertext is dropped.
 */
async function expireAbandonedUploads(deps: Deps): Promise<number> {
  const cutoff = new Date(Date.now() - ABANDONED_UPLOAD_HOURS * HOUR_MS);
  const stale = await deps.db
    .select({ id: objects.id, spaceId: objects.spaceId })
    .from(objects)
    .where(and(eq(objects.status, "queued"), lt(objects.createdAt, cutoff)))
    .limit(MAX_ABANDONED_PER_RUN);

  for (const object of stale) {
    await deps.db.transaction(async (tx) => {
      const [current] = await tx
        .update(objects)
        .set({ status: "failed" })
        .where(and(eq(objects.id, object.id), eq(objects.status, "queued")))
        .returning({ id: objects.id });
      if (!current) return;
      const items = await tx
        .select({ id: storedItems.id, sizeBytes: storedItems.sizeBytes })
        .from(storedItems)
        .where(eq(storedItems.objectId, object.id));
      if (items.length > 0) {
        await tx.delete(blobStaging).where(
          inArray(
            blobStaging.storedItemId,
            items.map((item) => item.id),
          ),
        );
      }
      if (object.spaceId) {
        const reserved = items.reduce((sum, item) => sum + item.sizeBytes, 0);
        await tx
          .update(spaces)
          .set({ usedBytes: sql`greatest(${spaces.usedBytes} - ${reserved}, 0)` })
          .where(eq(spaces.id, object.spaceId));
      }
      const [job] = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.kind, JOB_KIND.storeObject),
            sql`${jobs.payload}->>'objectId' = ${object.id}`,
          ),
        );
      if (job) {
        await updateJob(tx, job.id, {
          status: "failed",
          error: "The upload was never completed; its reserved quota was released.",
        });
      }
    });
  }
  return stale.length;
}
