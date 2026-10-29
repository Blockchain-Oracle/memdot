import { type Database, jobs, objects, storedItems } from "@memdot/db";
import { and, eq, notInArray, sql } from "drizzle-orm";
import { type JobPatch, updateJob } from "./record.js";

type Executor = Pick<Database, "select" | "update" | "execute">;

/** Objects in these states are finished with; nothing may move them again. */
const SETTLED_OBJECT = ["tombstoned", "failed"] as const;
const FINAL_JOB = ["finalized", "failed"] as const;

/** Jobs still following an object (its store, a restore or a "renew now"). */
export async function openJobsOf(db: Executor, objectId: string): Promise<string[]> {
  const rows = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.objectId, objectId), notInArray(jobs.status, [...FINAL_JOB])));
  return rows.map((row) => row.id);
}

/**
 * After one of an object's blobs is stored (by the relayer, a wallet or the indexer's repair):
 * once every blob is on chain the object, and the tiny-file entries packed in it, become
 * "stored". A deleted or failed object is never brought back. Each open job reports progress and
 * is finalized when the object is complete.
 */
export async function settleObject(
  db: Executor,
  objectId: string,
  jobIds: string[],
): Promise<void> {
  const items = await db
    .select({ status: storedItems.status })
    .from(storedItems)
    .where(eq(storedItems.objectId, objectId));
  const done = items.filter((item) => item.status === "stored").length;
  const complete = items.length > 0 && done === items.length;
  if (complete) {
    await db
      .update(objects)
      .set({ status: "stored" })
      .where(and(eq(objects.id, objectId), notInArray(objects.status, [...SETTLED_OBJECT])));
    await db
      .update(objects)
      .set({ status: "stored" })
      .where(and(eq(objects.segmentId, objectId), notInArray(objects.status, [...SETTLED_OBJECT])));
  }
  for (const jobId of jobIds) {
    await updateJob(db, jobId, {
      ...(complete ? { status: "finalized" } : {}),
      progress: { done, total: items.length },
    });
  }
}

/**
 * Gives up on an object that was never fully stored: it is marked failed, its blobs stop being
 * renewed (stored chunks simply expire), staged ciphertext is dropped and the quota it reserved
 * is returned. Only an object that is still in flight can fail, so this never runs twice.
 */
export async function failObject(db: Executor, objectId: string, reason: string): Promise<boolean> {
  const failed = await db.execute<{ id: string }>(sql`
    with old as (
      select id, space_id, reserved_bytes from objects
       where id = ${objectId} and status in ('queued', 'uploading')
       for update
    ), failed as (
      update objects o set status = 'failed', reserved_bytes = 0
        from old where o.id = old.id
      returning o.id, old.space_id, old.reserved_bytes
    ), quota as (
      update spaces s set used_bytes = greatest(s.used_bytes - failed.reserved_bytes, 0)
        from failed where s.id = failed.space_id and failed.reserved_bytes > 0
    ), released as (
      update stored_items si set status = 'released', renew_queued_at = null
        from failed where si.object_id = failed.id and si.status <> 'released'
      returning si.id
    ), unstaged as (
      delete from blob_staging b using released r where b.stored_item_id = r.id
    )
    select id from failed`);
  if (failed.rows.length === 0) return false;
  const patch: JobPatch = { status: "failed", error: reason };
  for (const jobId of await openJobsOf(db, objectId)) await updateJob(db, jobId, patch);
  return true;
}
