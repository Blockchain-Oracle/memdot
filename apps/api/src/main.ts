import { serve } from "@hono/node-server";
import { createChainClient } from "@memdot/chain";
import { MIGRATIONS_FOLDER, migrateDatabase } from "@memdot/db";
import { JobEventHub, startBoss } from "@memdot/jobs";
import { createApp } from "./app.js";
import { database } from "./db.js";
import { env } from "./env.js";
import { RequestLog } from "./lib/request-log.js";

/** Requests in flight get this long to finish when the container is stopped. */
const SHUTDOWN_GRACE_MS = 10_000;

await migrateDatabase(database, MIGRATIONS_FOLDER);

const boss = await startBoss(env.DATABASE_URL, "api");
const jobEvents = await JobEventHub.start(env.DATABASE_URL);
const chain = createChainClient(env.PORTALDOT_WSS);
const requestLog = new RequestLog(database.db);

const app = createApp({ boss, chain, jobEvents, requestLog });
const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`[api] listening on :${info.port}`);
});

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`[api] ${signal}: draining`);
  const force = setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS);
  force.unref();
  server.close();
  await requestLog.close();
  await jobEvents.close();
  await boss.stop({ graceful: true });
  chain.destroy();
  await database.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
