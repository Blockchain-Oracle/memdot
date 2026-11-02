import { type Database, folders, jobs, memories, objects } from "@memdot/db";
import { enqueueMemory, JOB_KIND } from "@memdot/jobs";
import { and, count, eq, isNull, notInArray, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { segmentHealth } from "./segments.js";

/** Past this many live segments, a namespace's renewals are worth merging (P4). */
export const COMPACT_ABOVE_SEGMENTS = 32;

/** Queues a compaction when a namespace has too many segments or a mostly dead one. */
export async function compactIfDue(
  db: Database,
  boss: PgBoss,
  scope: { accountId: string; folderId: string },
): Promise<void> {
  // Only a device can rewrite a Private namespace; the server can't read it.
  const [folder] = await db
    .select({ mode: folders.memoryMode })
    .from(folders)
    .where(eq(folders.id, scope.folderId));
  if (folder?.mode !== "assisted") return;
  const health = await segmentHealth(db, scope.folderId);
  const [failed] = await db
    .select({ n: count() })
    .from(memories)
    .innerJoin(objects, eq(objects.id, memories.segmentId))
    .where(
      and(
        eq(memories.folderId, scope.folderId),
        isNull(memories.deletedAt),
        eq(objects.status, "failed"),
      ),
    );
  const due =
    (failed?.n ?? 0) > 0 ||
    health.length > COMPACT_ABOVE_SEGMENTS ||
    health.some((segment) => segment.live * 2 < segment.entries);
  if (!due) return;
  const [open] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.kind, JOB_KIND.memoryCompact),
        eq(jobs.accountId, scope.accountId),
        sql`${jobs.payload}->>'folderId' = ${scope.folderId}`,
        notInArray(jobs.status, ["finalized", "failed"]),
      ),
    )
    .limit(1);
  if (open) return;
  await db.transaction(async (tx) => {
    const [job] = await tx
      .insert(jobs)
      .values({
        accountId: scope.accountId,
        kind: JOB_KIND.memoryCompact,
        payload: { folderId: scope.folderId },
      })
      .returning({ id: jobs.id });
    if (job) await enqueueMemory(boss, tx, { op: "compact", jobId: job.id });
  });
}
