/** pg-boss queue names shared by the API (which enqueues) and the worker (which runs them). */
export const QUEUE = {
  /** Every extrinsic the relayer signs. One active job at a time: one signer, one nonce sequence. */
  chainTx: "chain-tx",
  /** Cron: find stored items near the end of retention and enqueue renew batches. */
  keeperScan: "keeper-scan",
  /** Cron: follow finalized blocks and reconcile our records with TransactionStorage events. */
  indexer: "indexer",
  /** Ops alerts (low balance, renewal at risk) delivered to the Discord webhook. */
  alerts: "alerts",
} as const;

/**
 * Higher runs first on `chain-tx`. A missed renewal loses data; a late store only waits, so
 * renewals always jump the queue.
 */
export const PRIORITY = { renew: 30, store: 10 } as const;

/** Renewals one keeper job submits back to back with explicit nonces before awaiting them. */
export const RENEW_BATCH_SIZE = 20;

/** What a row in the `jobs` table is doing; shown to users as the job's title. */
export const JOB_KIND = {
  storeObject: "store_object",
  renew: "renew",
  /** The keeper re-storing an item that expired before it could be renewed. */
  restore: "restore",
} as const;
export type JobKind = (typeof JOB_KIND)[keyof typeof JOB_KIND];
