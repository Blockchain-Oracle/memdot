import { renew } from "@memdot/chain";
import { RENEW_FEE_PLANCK } from "@memdot/config";
import { jobs, renewals, storedItems } from "@memdot/db";
import { enqueueChainTx, type RenewBatchPayload, updateJob } from "@memdot/jobs";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { JobWithMetadata } from "pg-boss";
import { raiseAlert } from "../alerts.js";
import { type Deps, errorText, freeBalance, nextNonce } from "../deps.js";

type StoredItem = typeof storedItems.$inferSelect;

/**
 * Renews a batch. `renew` cannot be batched inside one extrinsic on V3, so each item is its own
 * top-level extrinsic; they are submitted back to back with explicit nonces and awaited together,
 * so a batch of 20 lands in a block or two instead of twenty. Items that moved since the batch was
 * queued were renewed already and are skipped.
 */
export async function handleRenew(deps: Deps, job: JobWithMetadata<RenewBatchPayload>) {
  const { items, jobId } = job.data;
  const expected = new Map(items.map((item) => [item.id, item.atBlock]));
  const rows = await deps.db
    .select()
    .from(storedItems)
    .where(inArray(storedItems.id, [...expected.keys()]));
  const due = rows.filter(
    (row) =>
      row.status === "stored" &&
      row.block !== null &&
      row.idx !== null &&
      row.block === expected.get(row.id),
  );
  const skipped = rows.filter((row) => !due.includes(row)).map((row) => row.id);
  if (skipped.length > 0) await clearQueued(deps, skipped);
  if (due.length === 0) {
    if (jobId) await settleRenewJob(deps, jobId);
    return;
  }

  try {
    const needed = RENEW_FEE_PLANCK * BigInt(due.length);
    const balance = await freeBalance(deps);
    if (balance < needed) {
      await raiseAlert(deps, {
        kind: "low_balance",
        message: `The relayer cannot pay for ${due.length} renewals (needs ~${needed} planck, has ${balance}). Top it up now: renewals are due.`,
        detail: { balance: balance.toString(), needed: needed.toString() },
      });
      throw new Error("relayer balance too low to renew");
    }

    if (jobId) await updateJob(deps.db, jobId, { status: "submitted" });
    const nonce = await nextNonce(deps);
    // Each renewal is recorded the moment it finalizes, not after the whole batch, so the indexer
    // never sees a finalized renewal that is not written down yet.
    const settled = await Promise.allSettled(
      due.map((row, k) =>
        renew(
          deps.chain.api,
          deps.signer.txCreator,
          { block: row.block ?? 0, index: row.idx ?? 0 },
          { nonce: nonce + k },
        ).then((result) => record(deps, row, result)),
      ),
    );

    const failed: { id: string; atBlock: number }[] = [];
    for (const [k, outcome] of settled.entries()) {
      const row = due[k];
      if (!row || outcome.status === "fulfilled") continue;
      console.error(`[renew] ${row.cid} at ${row.block}/${row.idx}: ${errorText(outcome.reason)}`);
      failed.push({ id: row.id, atBlock: row.block ?? 0 });
    }
    if (failed.length === due.length)
      throw new Error(`all ${failed.length} renewals in the batch failed`);
    if (failed.length > 0) {
      // Retry only what failed; the renewed items must not be paid for twice.
      await enqueueChainTx(deps.boss, deps.db, {
        action: "renew",
        items: failed,
        ...(jobId ? { jobId } : {}),
      });
    }
    if (jobId) await settleRenewJob(deps, jobId);
  } catch (error) {
    if (jobId && job.retryCount >= job.retryLimit) {
      await updateJob(deps.db, jobId, { status: "failed", error: errorText(error) });
    }
    if (job.retryCount >= job.retryLimit)
      await clearQueued(
        deps,
        due.map((row) => row.id),
      );
    throw error;
  }
}

/** Writes one renewal: the history row (once, even if the indexer saw it first) and the move. */
async function record(
  deps: Deps,
  row: StoredItem,
  result: Awaited<ReturnType<typeof renew>>,
): Promise<void> {
  const from = { block: row.block ?? 0, index: row.idx ?? 0 };
  await deps.db.transaction(async (tx) => {
    await tx
      .insert(renewals)
      .values({
        storedItemId: row.id,
        accountId: row.accountId,
        txHash: result.txHash,
        fromBlock: from.block,
        fromIdx: from.index,
        toBlock: result.location.block,
        toIdx: result.location.index,
        feePlanck: result.feePlanck?.toString() ?? null,
      })
      .onConflictDoNothing();
    await tx
      .update(storedItems)
      .set({
        block: result.location.block,
        idx: result.location.index,
        lastRenewedAt: new Date(),
        renewQueuedAt: null,
      })
      .where(and(eq(storedItems.id, row.id), eq(storedItems.block, from.block)));
  });
  console.log(
    `[renew] ${row.cid}: ${from.block}/${from.index} → ${result.location.block}/${result.location.index}`,
  );
}

async function clearQueued(deps: Deps, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await deps.db
    .update(storedItems)
    .set({ renewQueuedAt: null })
    .where(inArray(storedItems.id, ids));
}

/**
 * A "Renew now" job covers every stored blob of one object, possibly over several batches. It is
 * finalized once each of them was renewed after the job was created.
 */
async function settleRenewJob(deps: Deps, jobId: string): Promise<void> {
  const [job] = await deps.db.select().from(jobs).where(eq(jobs.id, jobId));
  if (!job?.objectId) return;
  const [counts] = await deps.db
    .select({
      total: sql<number>`count(*)::int`,
      done: sql<number>`count(*) filter (where ${storedItems.lastRenewedAt} >= ${job.createdAt})::int`,
    })
    .from(storedItems)
    .where(and(eq(storedItems.objectId, job.objectId), eq(storedItems.status, "stored")));
  const total = counts?.total ?? 0;
  const done = counts?.done ?? 0;
  await updateJob(deps.db, jobId, {
    ...(done >= total ? { status: "finalized" } : {}),
    progress: { done, total },
  });
}
