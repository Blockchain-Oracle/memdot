import { contentHash, storeChunk, type TxStage, toHex } from "@memdot/chain";
import { blobStaging, jobs, objects, storedItems } from "@memdot/db";
import {
  failObject,
  JOB_KIND,
  type JobStatus,
  openJobsOf,
  type StoreBlobPayload,
  settleObject,
  updateJob,
} from "@memdot/jobs";
import { and, eq } from "drizzle-orm";
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
export async function handleStore(deps: Deps, job: JobWithMetadata<StoreBlobPayload>) {
  const { jobId, storedItemId } = job.data;
  const [row] = await deps.db
    .select({ item: storedItems, data: blobStaging.data, object: objects })
    .from(storedItems)
    .innerJoin(objects, eq(objects.id, storedItems.objectId))
    .leftJoin(blobStaging, eq(blobStaging.storedItemId, storedItems.id))
    .where(eq(storedItems.id, storedItemId));

  // Deleted, already stored (a retry after success), or released by a tombstone or a failure:
  // whoever changed it also settled the job.
  if (!row) return;
  if (row.item.status !== "pending") return;
  const [owner] = await deps.db.select({ kind: jobs.kind }).from(jobs).where(eq(jobs.id, jobId));
  const isRestore = owner?.kind === JOB_KIND.restore;
  const fail = (reason: string) =>
    giveUp(deps, { objectId: row.object.id, storedItemId, jobId, isRestore, reason });
  if (!row.data) return fail("The ciphertext was lost before it could be stored.");
  if (toHex(contentHash(row.data)) !== row.item.contentHash) {
    return fail("Staged ciphertext does not match its CID.");
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
      // Only a still-pending item is recorded: if the object was deleted while the store was in
      // flight, the bytes are on chain but nobody renews them, and they expire.
      const recorded = await tx
        .update(storedItems)
        .set({
          status: "stored",
          block: result.location.block,
          idx: result.location.index,
          firstBlock: result.location.block,
          firstIdx: result.location.index,
          storedTxHash: result.txHash,
          storedAt: new Date(),
          feePlanck: result.feePlanck?.toString() ?? null,
          restoreAttempts: 0,
        })
        .where(and(eq(storedItems.id, storedItemId), eq(storedItems.status, "pending")))
        .returning({ id: storedItems.id });
      await tx.delete(blobStaging).where(eq(blobStaging.storedItemId, storedItemId));
      if (recorded.length === 0) return;
      await updateJob(tx, jobId, { txHash: result.txHash, block: result.location.block });
      await settleObject(tx, row.object.id, await openJobsOf(tx, row.object.id));
    });
    console.log(`[store] ${row.item.cid} → ${result.location.block}/${result.location.index}`);
  } catch (error) {
    if (job.retryCount >= job.retryLimit) await fail(errorText(error));
    else await updateJob(deps.db, jobId, { error: `Retrying: ${errorText(error)}` });
    throw error;
  }
}

interface GiveUp {
  objectId: string;
  storedItemId: string;
  jobId: string;
  isRestore: boolean;
  reason: string;
}

/**
 * Out of options. A first store fails the whole object (quota returned, nothing renewed). A
 * restore of one expired blob marks only that blob lost: the rest of the object is fine.
 */
async function giveUp(deps: Deps, failure: GiveUp): Promise<void> {
  const { objectId, storedItemId, jobId, isRestore, reason } = failure;
  if (isRestore) {
    await deps.db.transaction(async (tx) => {
      await tx
        .update(storedItems)
        .set({ status: "lost" })
        .where(and(eq(storedItems.id, storedItemId), eq(storedItems.status, "pending")));
      await tx.delete(blobStaging).where(eq(blobStaging.storedItemId, storedItemId));
      await updateJob(tx, jobId, { status: "failed", error: reason });
    });
    await raiseAlert(deps, {
      kind: "item_lost",
      message: `Re-storing an expired item failed: ${reason}`,
      detail: { objectId, storedItemId },
    });
    return;
  }
  const failed = await deps.db.transaction((tx) => failObject(tx, objectId, reason));
  if (!failed) return;
  const [owner] = await deps.db
    .select({ accountId: jobs.accountId })
    .from(jobs)
    .where(eq(jobs.id, jobId));
  await raiseAlert(deps, {
    kind: "store_failed",
    message: `A store gave up after retries: ${reason}`,
    detail: { objectId, jobId, accountId: owner?.accountId ?? null },
  });
}
