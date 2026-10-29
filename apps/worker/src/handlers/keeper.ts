import { bitswapGet } from "@memdot/chain";
import { ALERT_AT_FRACTION, RENEW_AT_FRACTION, RETENTION_BLOCKS } from "@memdot/config";
import { blobStaging, jobs, storedItems } from "@memdot/db";
import { enqueueChainTx, JOB_KIND, RENEW_BATCH_SIZE } from "@memdot/jobs";
import { and, asc, count, eq, gt, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { raiseAlert, resolveAlerts } from "../alerts.js";
import { type Deps, errorText } from "../deps.js";

const RENEW_DUE_BLOCKS = Math.floor(RETENTION_BLOCKS * RENEW_AT_FRACTION);
const ALERT_BLOCKS = Math.floor(RETENTION_BLOCKS * ALERT_AT_FRACTION);
/** Bounded so one scan never floods the queue; the next scan (10 minutes later) takes the rest. */
const MAX_DUE_PER_SCAN = 1_000;
const MAX_EXPIRED_PER_SCAN = 50;
/** A queued renewal not done after this long (a worker restart, say) may be queued again. */
const REQUEUE_AFTER_MS = 60 * 60 * 1000;
/** Re-store attempts, one per scan (~1 hour in all), before an expired item is declared lost. */
const MAX_RESTORE_ATTEMPTS = 6;

/**
 * Every 10 minutes: renew every stored blob past 80% of its retention (R2: manifests, chunks,
 * segments, key bundles, grant keys and snapshots alike), raise an alert for any past 90%, and
 * re-store anything that expired anyway.
 */
export async function keeperScan(deps: Deps): Promise<void> {
  const head = (await deps.chain.client.getFinalizedBlock()).number;
  const renewAfter = deps.env.KEEPER_RENEW_AFTER_BLOCKS ?? RENEW_DUE_BLOCKS;
  const expiredAt = head - RETENTION_BLOCKS;

  const queued = await deps.db.transaction(async (tx) => {
    const due = await tx
      .select({ id: storedItems.id, block: storedItems.block })
      .from(storedItems)
      .where(
        and(
          eq(storedItems.status, "stored"),
          lte(storedItems.block, head - renewAfter),
          // Past retention a renew fails on chain; those are re-stored below instead.
          gt(storedItems.block, expiredAt),
          or(
            isNull(storedItems.renewQueuedAt),
            lt(storedItems.renewQueuedAt, new Date(Date.now() - REQUEUE_AFTER_MS)),
          ),
        ),
      )
      .orderBy(asc(storedItems.block))
      .limit(MAX_DUE_PER_SCAN)
      .for("update", { skipLocked: true });
    const items = due.flatMap((row) =>
      row.block === null ? [] : [{ id: row.id, atBlock: row.block }],
    );
    if (items.length === 0) return 0;
    await tx
      .update(storedItems)
      .set({ renewQueuedAt: new Date() })
      .where(
        inArray(
          storedItems.id,
          items.map((item) => item.id),
        ),
      );
    for (let i = 0; i < items.length; i += RENEW_BATCH_SIZE) {
      await enqueueChainTx(deps.boss, tx, {
        action: "renew",
        items: items.slice(i, i + RENEW_BATCH_SIZE),
      });
    }
    return items.length;
  });

  const [atRisk] = await deps.db
    .select({ n: count() })
    .from(storedItems)
    .where(
      and(
        eq(storedItems.status, "stored"),
        lte(storedItems.block, head - ALERT_BLOCKS),
        gt(storedItems.block, expiredAt),
      ),
    );
  if ((atRisk?.n ?? 0) > 0) {
    await raiseAlert(deps, {
      kind: "renewal_at_risk",
      message: `${atRisk?.n} stored items are past 90% of their retention and not renewed yet.`,
      detail: { count: atRisk?.n, headBlock: head },
    });
  } else {
    await resolveAlerts(deps, "renewal_at_risk");
  }

  await restoreExpired(deps, expiredAt);
  console.log(`[keeper] head ${head}: ${queued} queued for renewal, ${atRisk?.n ?? 0} at risk`);
}

/**
 * An item past retention can no longer be renewed, but archive nodes may still serve it. If its
 * bytes are retrievable they are stored again (same CID, new location). A failed fetch is retried
 * on the next scans; only after MAX_RESTORE_ATTEMPTS is the item declared lost.
 */
async function restoreExpired(deps: Deps, expiredAt: number): Promise<void> {
  const expired = await deps.db
    .select()
    .from(storedItems)
    .where(
      and(
        inArray(storedItems.status, ["stored", "expired_served"]),
        lte(storedItems.block, expiredAt),
      ),
    )
    .limit(MAX_EXPIRED_PER_SCAN);

  for (const item of expired) {
    let bytes: Uint8Array;
    try {
      bytes = await bitswapGet(deps.chain.client, item.cid);
    } catch (error) {
      const attempts = item.restoreAttempts + 1;
      const lost = attempts >= MAX_RESTORE_ATTEMPTS;
      await deps.db
        .update(storedItems)
        .set({ status: lost ? "lost" : "expired_served", restoreAttempts: attempts })
        .where(eq(storedItems.id, item.id));
      if (lost) {
        await raiseAlert(deps, {
          kind: "item_lost",
          message: `${item.cid} expired and no node served it after ${attempts} tries: ${errorText(error)}`,
          detail: { storedItemId: item.id, cid: item.cid },
        });
      }
      continue;
    }
    await deps.db.transaction(async (tx) => {
      const [job] = await tx
        .insert(jobs)
        .values({
          accountId: item.accountId,
          objectId: item.objectId,
          kind: JOB_KIND.restore,
          payload: { objectId: item.objectId, storedItemId: item.id },
        })
        .returning({ id: jobs.id });
      if (!job) throw new Error("restore job insert returned no row");
      await tx
        .insert(blobStaging)
        .values({ storedItemId: item.id, data: bytes })
        .onConflictDoNothing();
      await tx
        .update(storedItems)
        .set({
          status: "pending",
          renewQueuedAt: null,
          restoreAttempts: sql`${storedItems.restoreAttempts} + 1`,
        })
        .where(eq(storedItems.id, item.id));
      await enqueueChainTx(deps.boss, tx, {
        action: "store",
        jobId: job.id,
        storedItemId: item.id,
      });
    });
    console.warn(`[keeper] ${item.cid} expired at ${item.block}; re-storing from a serving node`);
  }
}
