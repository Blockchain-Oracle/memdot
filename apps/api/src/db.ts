import { createDatabase } from "@memdot/db";
import { env } from "./env.js";

/** The process-wide pool, shared by routes, Better Auth and the job queue. */
export const database = createDatabase(env.DATABASE_URL);
export const db = database.db;
