import { type Database, objects, storedItems } from "@memdot/db";
import { eq } from "drizzle-orm";
import { updateJob } from "./record.js";

type Executor = Pick<Database, "select" | "update" | "execute">;

/**
 * After one of an object's blobs is stored (by the relayer or a wallet): once every blob is on
 * chain the object, and any tiny-file entries packed in it, become "stored" and its job is
 * finalized; until then the job reports progress.
 */
export async function settleObject(
  db: Executor,
  objectId: string,
  jobId: string | null,
): Promise<void> {
  const items = await db
    .select({ status: storedItems.status })
    .from(storedItems)
    .where(eq(storedItems.objectId, objectId));
  const done = items.filter((item) => item.status === "stored").length;
  const complete = items.length > 0 && done === items.length;
  if (complete) {
    await db.update(objects).set({ status: "stored" }).where(eq(objects.id, objectId));
    await db.update(objects).set({ status: "stored" }).where(eq(objects.segmentId, objectId));
  }
  if (jobId) {
    await updateJob(db, jobId, {
      ...(complete ? { status: "finalized" } : {}),
      progress: { done, total: items.length },
    });
  }
}
