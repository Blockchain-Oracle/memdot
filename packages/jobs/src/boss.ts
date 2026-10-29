import type { Database } from "@memdot/db";
import { sql } from "drizzle-orm";
import { fromDrizzle, PgBoss } from "pg-boss";
import type { ChainTxPayload } from "./payloads.js";
import { PRIORITY, QUEUE } from "./queues.js";

const CHAIN_TX_RETRIES = 5;
const CHAIN_TX_RETRY_DELAY_SECONDS = 15;
/** A 7 MB store waits for finality (~2 blocks); a renew batch waits for up to 20. */
const CHAIN_TX_EXPIRE_SECONDS = 15 * 60;
/** Finished chain jobs stay visible to ops for a month. */
const CHAIN_TX_KEEP_SECONDS = 30 * 24 * 60 * 60;

export type BossRole = "api" | "worker";

/**
 * Starts pg-boss and makes sure every queue exists (`create_queue` is idempotent). The API only
 * enqueues, so it runs no maintenance or cron; the worker does both.
 */
export async function startBoss(connectionString: string, role: BossRole): Promise<PgBoss> {
  const isWorker = role === "worker";
  const boss = new PgBoss({
    connectionString,
    application_name: `memdot-${role}`,
    max: isWorker ? 4 : 2,
    supervise: isWorker,
    schedule: isWorker,
  });
  boss.on("error", (error) => console.error("[pg-boss]", error));
  await boss.start();

  await boss.createQueue(QUEUE.chainTx, {
    policy: "singleton",
    retryLimit: CHAIN_TX_RETRIES,
    retryDelay: CHAIN_TX_RETRY_DELAY_SECONDS,
    retryBackoff: true,
    expireInSeconds: CHAIN_TX_EXPIRE_SECONDS,
    deleteAfterSeconds: CHAIN_TX_KEEP_SECONDS,
  });
  await boss.createQueue(QUEUE.keeperScan, { policy: "exclusive" });
  await boss.createQueue(QUEUE.indexer, { policy: "exclusive" });
  await boss.createQueue(QUEUE.alerts, { retryLimit: 3, retryDelay: 30, retryBackoff: true });
  return boss;
}

/** Anything Drizzle can run SQL through: the database or an open transaction. */
type Executor = Pick<Database, "execute">;

/**
 * Enqueues relayer work inside the caller's transaction, so the `jobs` row and the queue entry
 * commit together. A store job's id is its stored item id, which makes a repeated enqueue a no-op.
 */
export async function enqueueChainTx(
  boss: PgBoss,
  executor: Executor,
  payload: ChainTxPayload,
): Promise<void> {
  const db = fromDrizzle(executor, sql);
  if (payload.action === "store") {
    await boss.send(QUEUE.chainTx, payload, {
      id: payload.storedItemId,
      priority: PRIORITY.store,
      db,
    });
    return;
  }
  await boss.send(QUEUE.chainTx, payload, { priority: PRIORITY.renew, db });
}
