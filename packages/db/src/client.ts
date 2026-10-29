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

/** One pool per process, shared by Drizzle, the job queue and auth. */
export function createDatabase(connectionString: string, max = 10): DatabaseHandle {
  const pool = new pg.Pool({ connectionString, max });
  return { db: drizzle(pool, { schema }), pool, close: () => pool.end() };
}

/** Advisory-lock key so only one process migrates when several containers start together. */
const MIGRATION_LOCK_KEY = 4_237_119_421;

/**
 * Runs pending migrations at boot. Coolify's pre-deploy hook runs in the old container, so the
 * API migrates itself here instead, serialized by a Postgres advisory lock.
 */
export async function migrateDatabase(
  handle: DatabaseHandle,
  migrationsFolder: string,
): Promise<void> {
  const client = await handle.pool.connect();
  try {
    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    await migrate(handle.db, { migrationsFolder });
  } finally {
    await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]);
    client.release();
  }
}
