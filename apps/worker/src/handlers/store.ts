import { contentHash, storeChunk, type TxStage, toHex } from "@memdot/chain";
import { blobStaging, jobs, objects, spaces, storedItems } from "@memdot/db";
import { type JobStatus, type StoreBlobPayload, settleObject, updateJob } from "@memdot/jobs";
import { and, eq, sql } from "drizzle-orm";
import type { JobWithMetadata } from "pg-boss";
import { raiseAlert } from "../alerts.js";
import { type Deps, errorText } from "../deps.js";

const STAGE_STATUS: Record<Exclude<TxStage, "finalized">, JobStatus> = {
  submitted: "submitted",
  "in-block": "in_block",
};

/**
 * Stores one staged blob with the relayer: a top-level `TransactionStorage.store`, awaited to
 * finality. The job row follows each stage; when the object's last blob lands, it is settled.
 */
export async function handleStore(
  deps: Deps,
  job: JobWithMetadata<StoreBlobPayload>,
): Promise<void> {
  const { jobId, storedItemId } = job.data;
  const [row] = await deps.db
    .select({ item: storedItems, data: blobStaging.data, object: objects })
    .from(storedItems)
    .innerJoin(objects, eq(objects.id, storedItems.objectId))
    .leftJoin(blobStaging, eq(blobStaging.storedItemId, storedItems.id))
    .where(eq(storedItems.id, storedItemId));

  // Deleted, already stored (a retry after success), or released by a tombstone: nothing to do.
  if (!row) return;
  if (row.item.status !== "pending" || row.object.status === "tombstoned") return;
  if (!row.data) throw new Error(`stored item ${storedItemId} has no staged ciphertext`);
  if (toHex(contentHash(row.data)) !== row.item.contentHash) {
    await failObject(deps, row.object.id, jobId, "Staged ciphertext does not match its CID.");
    return;
  }

  try {
    await updateJob(deps.db, jobId, { status: "running" });
    const stageWrites: Promise<unknown>[] = [];
    const result = await storeChunk(deps.chain.api, deps.signer.txCreator, row.data, {
      onStage: (stage, detail) => {
        if (stage === "finalized") return;
        stageWrites.push(
          updateJob(deps.db, jobId, {
            status: STAGE_STATUS[stage],
            txHash: detail.txHash,
            block: detail.block ?? null,
          }),
        );
      },
    });
    await Promise.allSettled(stageWrites);

    await deps.db.transaction(async (tx) => {
      await tx
        .update(storedItems)
        .set({
          status: "stored",
          block: result.location.block,
          idx: result.location.index,
          storedTxHash: result.txHash,
          storedAt: new Date(),
          feePlanck: result.feePlanck?.toString() ?? null,
        })
        .where(eq(storedItems.id, storedItemId));
      await tx.delete(blobStaging).where(eq(blobStaging.storedItemId, storedItemId));
      await updateJob(tx, jobId, { txHash: result.txHash, block: result.location.block });
      await settleObject(tx, row.object.id, jobId);
    });
    console.log(`[store] ${row.item.cid} → ${result.location.block}/${result.location.index}`);
  } catch (error) {
    const lastAttempt = job.retryCount >= job.retryLimit;
    if (lastAttempt) await failObject(deps, row.object.id, jobId, errorText(error));
    else await updateJob(deps.db, jobId, { error: `Retrying: ${errorText(error)}` });
    throw error;
  }
}

/**
 * Gives up on an object: the job and object are marked failed and its reserved quota is returned,
 * since nothing more will be stored for it.
 */
async function failObject(
  deps: Deps,
  objectId: string,
  jobId: string,
  reason: string,
): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const [object] = await tx
      .update(objects)
      .set({ status: "failed" })
      .where(and(eq(objects.id, objectId), sql`${objects.status} <> 'failed'`))
      .returning({ spaceId: objects.spaceId });
    if (object?.spaceId) {
      const [reserved] = await tx
        .select({ bytes: sql<number>`coalesce(sum(${storedItems.sizeBytes}), 0)::int` })
        .from(storedItems)
        .where(eq(storedItems.objectId, objectId));
      await tx
        .update(spaces)
        .set({ usedBytes: sql`greatest(${spaces.usedBytes} - ${reserved?.bytes ?? 0}, 0)` })
        .where(eq(spaces.id, object.spaceId));
    }
    await tx
      .delete(blobStaging)
      .where(
        sql`${blobStaging.storedItemId} in (select id from stored_items where object_id = ${objectId})`,
      );
    await updateJob(tx, jobId, { status: "failed", error: reason });
  });
  const [job] = await deps.db
    .select({ accountId: jobs.accountId })
    .from(jobs)
    .where(eq(jobs.id, jobId));
  await raiseAlert(deps, {
    kind: "store_failed",
    message: `A store gave up after retries: ${reason}`,
    detail: { objectId, jobId, accountId: job?.accountId ?? null },
  });
}
