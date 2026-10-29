import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  // Product tables live in `public`; Better Auth tables in `auth`.
  schemaFilter: ["public", "auth"],
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://memdot:memdot@localhost:5434/memdot",
  },
});
