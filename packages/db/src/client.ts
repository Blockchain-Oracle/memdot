import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import * as schema from "./schema/index.js";

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseHandle {
  db: Database;
  pool: pg.Pool;
  close: () => Promise<void>;
}

/** Waiting longer than this for a free connection fails the request instead of hanging it. */
const CONNECT_TIMEOUT_MS = 10_000;
/** No single statement may hold a connection longer than this. */
const STATEMENT_TIMEOUT_MS = 30_000;
/** A transaction left open and idle (a bug, a crashed handler) is ended by the server. */
const IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;

/** One pool per process, shared by Drizzle, the job queue and auth. */
export function createDatabase(connectionString: string, max = 10): DatabaseHandle {
  const pool = new pg.Pool({
    connectionString,
    max,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    options: `-c statement_timeout=${STATEMENT_TIMEOUT_MS} -c idle_in_transaction_session_timeout=${IDLE_IN_TRANSACTION_TIMEOUT_MS}`,
  });
  return { db: drizzle(pool, { schema }), pool, close: () => pool.end() };
}

/** Advisory-lock key so only one process migrates when several containers start together. */
const MIGRATION_LOCK_KEY = 4_237_119_421;

/**
 * Runs pending migrations at boot. Coolify's pre-deploy hook runs in the old container, so the
 * API migrates itself here instead, serialized by a Postgres advisory lock. The migration runs on
 * the connection that holds the lock, with no statement timeout (index builds can be long).
 */
export async function migrateDatabase(
  handle: DatabaseHandle,
  migrationsFolder: string,
): Promise<void> {
  const client = await handle.pool.connect();
  try {
    await client.query("set statement_timeout = 0");
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await migrate(drizzle(client, { schema }), { migrationsFolder });
  } finally {
    await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    await client.query(`set statement_timeout = ${STATEMENT_TIMEOUT_MS}`);
    client.release();
  }
}
