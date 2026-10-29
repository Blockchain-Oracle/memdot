import { createChainClient, formatTpot, signerFromMnemonic } from "@memdot/chain";
import { createDatabase, MIGRATIONS_FOLDER, migrateDatabase } from "@memdot/db";
import { chainTxPayload, PRIORITY, QUEUE, startBoss } from "@memdot/jobs";
import type { Job, JobWithMetadata } from "pg-boss";
import { type AlertMessage, deliverAlert } from "./alerts.js";
import { StoreBreaker } from "./breaker.js";
import { type Deps, freeBalance } from "./deps.js";
import { env } from "./env.js";
import { indexChain } from "./handlers/indexer.js";
import { keeperScan } from "./handlers/keeper.js";
import { handleRenew } from "./handlers/renew.js";
import { handleStore } from "./handlers/store.js";

const BREAKER_CHECK_MS = 60_000;
const CHAIN_TX_POLL_SECONDS = 2;
const SHUTDOWN_GRACE_MS = 30_000;

const database = createDatabase(env.DATABASE_URL, 5);
await migrateDatabase(database, MIGRATIONS_FOLDER);

const boss = await startBoss(env.DATABASE_URL, "worker");
const chain = createChainClient(env.PORTALDOT_WSS);
const signer = signerFromMnemonic(env.SIGNER_MNEMONIC);
const deps: Deps = { db: database.db, boss, chain, signer, env };

async function runChainTx([job]: JobWithMetadata<unknown>[]): Promise<void> {
  if (!job) return;
  const payload = chainTxPayload.parse(job.data);
  if (payload.action === "store") await handleStore(deps, { ...job, data: payload });
  else await handleRenew(deps, { ...job, data: payload });
}

// One signer, one queue (singleton policy: one active job at a time across both workers).
// Renewals have their own worker so the low-balance breaker can pause stores without them.
await boss.work(
  QUEUE.chainTx,
  {
    minPriority: PRIORITY.renew,
    pollingIntervalSeconds: CHAIN_TX_POLL_SECONDS,
    includeMetadata: true,
  },
  runChainTx,
);
const breaker = new StoreBreaker(deps, () =>
  boss.work(
    QUEUE.chainTx,
    {
      maxPriority: PRIORITY.store,
      pollingIntervalSeconds: CHAIN_TX_POLL_SECONDS,
      includeMetadata: true,
    },
    runChainTx,
  ),
);
await breaker.refresh();
const breakerTimer = setInterval(
  () => void breaker.refresh().catch((error) => console.error("[breaker]", error)),
  BREAKER_CHECK_MS,
);
breakerTimer.unref();

await boss.schedule(QUEUE.keeperScan, "*/10 * * * *");
await boss.work(QUEUE.keeperScan, () => keeperScan(deps));
await boss.schedule(QUEUE.indexer, "* * * * *");
await boss.work(QUEUE.indexer, () => indexChain(deps));
await boss.work(QUEUE.alerts, async ([job]: Job<unknown>[]) => {
  if (job) await deliverAlert(env, job.data as AlertMessage);
});
// Do not wait up to ten minutes after a deploy for the first scan.
await boss.send(QUEUE.keeperScan, {});
await boss.send(QUEUE.indexer, {});

console.log(
  `[worker] relayer ${signer.address} with ${formatTpot(await freeBalance(deps))}; stores ${breaker.open ? "paused (low balance)" : "running"}`,
);

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`[worker] ${signal}: finishing the current job`);
  const force = setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS);
  force.unref();
  clearInterval(breakerTimer);
  await boss.stop({ graceful: true });
  chain.destroy();
  await database.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
