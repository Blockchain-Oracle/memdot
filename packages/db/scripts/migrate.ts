// Applies migrations to DATABASE_URL (the repo-root .env in development).
import { existsSync } from "node:fs";
import { createDatabase, MIGRATIONS_FOLDER, migrateDatabase } from "../src/index.js";

const envUrl = new URL("../../../.env", import.meta.url);
if (existsSync(envUrl)) process.loadEnvFile(envUrl);
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");

const handle = createDatabase(url, 2);
try {
  await migrateDatabase(handle, MIGRATIONS_FOLDER);
  console.log("Migrations applied");
} finally {
  await handle.close();
}
