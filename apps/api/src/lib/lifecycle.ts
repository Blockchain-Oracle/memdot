import { type Database, jobs, objects } from "@memdot/db";
import { updateJob } from "@memdot/jobs";
import { and, eq, notInArray, type SQL, sql } from "drizzle-orm";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * One delete semantics (R6): tombstone the objects, stop renewing their blobs, drop staged
 * ciphertext and give each object's reserved bytes back to its space, exactly once. Bytes already
 * on chain expire on their own within the retention window. Done in one statement whatever the
 * number of objects (a memory space can hold hundreds of thousands).
 */
export async function tombstoneObjects(tx: Tx, where: SQL): Promise<number> {
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

  const result = await tx.execute<{ n: number }>(sql`
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
    select count(*)::int as n from tombstoned`);

  for (const job of openJobs) {
    await updateJob(tx, job.id, { status: "failed", error: "The object was deleted." });
  }
  return result.rows[0]?.n ?? 0;
}
