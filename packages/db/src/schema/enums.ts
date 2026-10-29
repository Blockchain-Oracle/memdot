import { pgEnum } from "drizzle-orm/pg-core";

export const spaceMode = pgEnum("space_mode", ["sponsored", "self_signed"]);

export const memoryMode = pgEnum("memory_mode", ["off", "private", "assisted"]);

/** What a stored object is; mirrors MemDotRegistry.ObjectKind. */
export const objectKind = pgEnum("object_kind", [
  "file",
  "manifest",
  "segment",
  "index_snapshot",
  "key_bundle",
  "grant_key",
]);

export const objectStatus = pgEnum("object_status", [
  "queued",
  "uploading",
  "stored",
  "failed",
  "tombstoned",
  "lost",
]);

/** One stored item on V3 TransactionStorage, as the keeper sees it. */
export const storedItemStatus = pgEnum("stored_item_status", [
  "pending",
  "stored",
  "expired_served",
  "lost",
  "released",
]);

/** The R4 pipeline every async action reports. */
export const jobStatus = pgEnum("job_status", [
  "queued",
  "running",
  "submitted",
  "in_block",
  "finalized",
  "failed",
]);

export const grantScope = pgEnum("grant_scope", ["read", "read_write"]);

export const grantStatus = pgEnum("grant_status", ["pending", "active", "revoked", "expired"]);

export const granteeKind = pgEnum("grantee_kind", ["account", "agent"]);
