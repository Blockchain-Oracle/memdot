import {
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { granteeKind, grantScope, grantStatus, jobStatus } from "./enums.js";
import { accounts, createdAt, objects, spaces } from "./storage.js";

/**
 * Access to a space or one object. A grant is "pending" until the recipient has registered an
 * encryption key and the owner's client has wrapped the key to it.
 */
export const grants = pgTable(
  "grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    chainGrantId: text("chain_grant_id"),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => spaces.id),
    objectId: uuid("object_id").references(() => objects.id),
    granteeKind: granteeKind("grantee_kind").notNull(),
    /** AccountId32 hex for accounts, X25519 public key hex for agents. */
    grantee: text("grantee").notNull(),
    scope: grantScope("scope").notNull().default("read"),
    status: grantStatus("status").notNull().default("pending"),
    wrappedKeyCid: text("wrapped_key_cid"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: createdAt(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    index("grants_space_idx").on(t.spaceId),
    index("grants_grantee_idx").on(t.grantee, t.status),
  ],
);

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    label: text("label").notNull(),
    /** e.g. claude-code, cursor, codex, sdk */
    client: text("client").notNull(),
    publicKey: text("public_key").notNull(),
    createdAt: createdAt(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("agents_key_idx").on(t.publicKey),
    index("agents_account_idx").on(t.accountId),
  ],
);

/**
 * Every async action (store, renew, registry write, remember…) is a job. This table is the
 * record of truth for status; the queue only schedules work.
 */
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id").references(() => accounts.id),
    kind: text("kind").notNull(),
    /** The object a store, restore or "renew now" job is about. */
    objectId: uuid("object_id").references(() => objects.id),
    status: jobStatus("status").notNull().default("queued"),
    idempotencyKey: text("idempotency_key"),
    payload: jsonb("payload").notNull().default({}),
    result: jsonb("result"),
    error: text("error"),
    txHash: text("tx_hash"),
    block: integer("block"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("jobs_idempotency_idx").on(t.accountId, t.idempotencyKey),
    index("jobs_account_idx").on(t.accountId, t.createdAt, t.id),
    index("jobs_object_idx").on(t.objectId, t.kind),
  ],
);

/** Request metadata only (R10): never bodies, never decrypted content. */
export const requestLogs = pgTable(
  "request_logs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    accountId: uuid("account_id"),
    apiKeyPrefix: text("api_key_prefix"),
    client: text("client"),
    method: text("method").notNull(),
    path: text("path").notNull(),
    status: integer("status").notNull(),
    latencyMs: integer("latency_ms").notNull(),
    requestId: text("request_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("request_logs_account_idx").on(t.accountId, t.createdAt, t.id),
    index("request_logs_created_brin").using("brin", t.createdAt),
  ],
);

export const opsAlerts = pgTable("ops_alerts", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").notNull(),
  message: text("message").notNull(),
  detail: jsonb("detail"),
  createdAt: createdAt(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

/** Where each indexer stream has read up to, so restarts resume and rebuilds start at 0. */
export const chainCursors = pgTable("chain_cursors", {
  name: text("name").primaryKey(),
  block: integer("block").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
