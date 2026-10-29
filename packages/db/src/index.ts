export { createDatabase, type Database, type DatabaseHandle, migrateDatabase } from "./client.js";
export * from "./schema/index.js";

/** Absolute path to the SQL migrations shipped with this package. */
export const MIGRATIONS_FOLDER = new URL("../migrations", import.meta.url).pathname;
