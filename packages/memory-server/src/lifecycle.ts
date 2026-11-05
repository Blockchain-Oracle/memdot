import { type Database, jobs, memories, objects } from "@memdot/db";
import { updateJob } from "@memdot/jobs";
import { and, eq, inArray, notInArray, or, type SQL, sql } from "drizzle-orm";
import { forgetRows } from "./rows.js";
import { emptySegments } from "./segments.js";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * One delete semantics (R6): tombstone the objects, stop renewing their blobs, drop staged
 * ciphertext and give each object's reserved bytes back to its space, exactly once. Bytes already
 * on chain expire on their own within the retention window. Done in one statement whatever the
 * number of objects (a memory space can hold hundreds of thousands).
 *
 * Memories follow (R8): those stored in a tombstoned segment or read from a tombstoned file are
 * forgotten, and a segment left with nothing live is tombstoned in turn.
 */
export async function tombstoneObjects(
  tx: Tx,
  where: SQL,
  /** Filled with the memories this forgot, for whoever needs to announce it after the commit. */
  forgotten?: string[],
): Promise<number> {
  // Jobs still following these objects end now, so no progress stream waits on them forever.
  const openJobs = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .innerJoin(objects, eq(objects.id, jobs.objectId))
    .where(
      and(
        where,
        sql`${objects.status} <> 'tombstoned'`,
        notInArray(jobs.status, ["finalized", "failed"]),
      ),
    );

  const result = await tx.execute<{ id: string }>(sql`
    with old as (
      select id, space_id, reserved_bytes from objects
       where ${where} and status <> 'tombstoned'
       for update
    ), tombstoned as (
      update objects o set status = 'tombstoned', tombstoned_at = now(), reserved_bytes = 0
        from old where o.id = old.id
      returning o.id, old.space_id, old.reserved_bytes
    ), released as (
      update stored_items si set status = 'released', renew_queued_at = null
        from tombstoned t where si.object_id = t.id and si.status <> 'released'
      returning si.id
    ), unstaged as (
      delete from blob_staging b using released r where b.stored_item_id = r.id
    ), quota as (
      update spaces s set used_bytes = greatest(s.used_bytes - freed.bytes, 0)
        from (
          select space_id, sum(reserved_bytes) as bytes from tombstoned
           where space_id is not null and reserved_bytes > 0
           group by space_id
        ) freed
       where s.id = freed.space_id
    )
    select id from tombstoned`);

  for (const job of openJobs) {
    await updateJob(tx, job.id, { status: "failed", error: "The object was deleted." });
  }

  const ids = result.rows.map((row) => row.id);
  if (ids.length > 0) {
    const { ids: memoryIds, segmentIds } = await forgetRows(
      tx,
      or(inArray(memories.segmentId, ids), inArray(memories.sourceObjectId, ids)),
      null,
    );
    forgotten?.push(...memoryIds);
    const empty = await emptySegments(
      tx,
      segmentIds.filter((id) => !ids.includes(id)),
    );
    if (empty.length > 0) await tombstoneObjects(tx, inArray(objects.id, empty) as SQL, forgotten);
  }
  return ids.length;
}
