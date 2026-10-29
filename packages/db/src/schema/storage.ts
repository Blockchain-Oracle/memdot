import { sql } from "drizzle-orm";
import {
  bigint,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth.js";
import {
  memoryMode,
  objectKind,
  objectStatus,
  spaceMode,
  storedItemRole,
  storedItemStatus,
} from "./enums.js";

const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({
  dataType: () => "bytea",
  toDriver: (value) => Buffer.from(value),
  fromDriver: (value) => new Uint8Array(value),
});

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/**
 * A MemDot account: the on-chain owner (AccountId32) plus the public parts of its keys. The
 * master key and every secret stay on the client; only public keys and CIDs live here. Sign-in
 * methods (passkeys, wallets, the recovery-code key) live in the `auth` schema.
 */
export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id),
    /** AccountId32 as 0x-hex: the sr25519 public key that owns registry records. */
    ownerAccount: text("owner_account").notNull(),
    evmAddress: text("evm_address"),
    /** X25519 sharing key published in the registry. */
    encryptionKey: text("encryption_key"),
    keyBundleCid: text("key_bundle_cid"),
    createdAt: createdAt(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("accounts_user_idx").on(t.userId),
    uniqueIndex("accounts_owner_idx").on(t.ownerAccount),
  ],
);

export const spaces = pgTable(
  "spaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    /** bytes32 id from MemDotRegistry.createSpace, once registered on-chain. */
    chainSpaceId: text("chain_space_id"),
    /** Space name sealed to the space key; decrypted in the client. */
    encryptedName: bytea("encrypted_name").notNull(),
    mode: spaceMode("mode").notNull().default("sponsored"),
    keyEpoch: integer("key_epoch").notNull().default(0),
    quotaBytes: bigint("quota_bytes", { mode: "number" }).notNull(),
    usedBytes: bigint("used_bytes", { mode: "number" }).notNull().default(0),
    createdAt: createdAt(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    index("spaces_account_idx").on(t.accountId),
    uniqueIndex("spaces_chain_idx").on(t.chainSpaceId).where(sql`${t.chainSpaceId} is not null`),
  ],
);

export const folders = pgTable(
  "folders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => spaces.id),
    parentId: uuid("parent_id"),
    encryptedName: bytea("encrypted_name").notNull(),
    memoryMode: memoryMode("memory_mode").notNull().default("off"),
    createdAt: createdAt(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [index("folders_space_idx").on(t.spaceId, t.parentId)],
);

/**
 * A logical object the user sees: a file (its manifest), a segment of tiny files or memories,
 * an index snapshot, a key bundle or a wrapped grant key. Key bundles and grant keys belong to
 * the account rather than a space.
 */
export const objects = pgTable(
  "objects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    spaceId: uuid("space_id").references(() => spaces.id),
    folderId: uuid("folder_id").references(() => folders.id),
    kind: objectKind("kind").notNull(),
    status: objectStatus("status").notNull().default("queued"),
    /** blake2b-256 of the root blob (manifest, segment, bundle); the CID encodes the same hash. */
    contentHash: text("content_hash"),
    cid: text("cid"),
    /** Padded plaintext size the client reported (real size lives in the manifest). */
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    /** Name and MIME type sealed to the space key, so listings need no manifest fetch. */
    encryptedMeta: bytea("encrypted_meta"),
    /** Tiny files live inside a segment object. */
    segmentId: uuid("segment_id"),
    previousVersionId: uuid("previous_version_id"),
    createdAt: createdAt(),
    tombstonedAt: timestamp("tombstoned_at", { withTimezone: true }),
  },
  (t) => [
    index("objects_account_idx").on(t.accountId, t.createdAt),
    index("objects_space_folder_idx").on(t.spaceId, t.folderId),
    index("objects_segment_idx").on(t.segmentId),
    uniqueIndex("objects_space_hash_idx")
      .on(t.spaceId, t.contentHash)
      .where(sql`${t.contentHash} is not null`),
  ],
);

/**
 * Every item MemDot keeps alive on V3 TransactionStorage. The keeper renews rows by
 * (block, idx) before the retention window ends; `renew` keeps the CID and moves the location.
 */
export const storedItems = pgTable(
  "stored_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    objectId: uuid("object_id").references(() => objects.id),
    role: storedItemRole("role").notNull().default("root"),
    /** Order of a data chunk within its object; always 0 for the root. */
    chunkIndex: integer("chunk_index").notNull().default(0),
    contentHash: text("content_hash").notNull(),
    cid: text("cid").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    status: storedItemStatus("status").notNull().default("pending"),
    block: integer("block"),
    /** Index inside the block's TransactionStorage list (from the Stored/Renewed event). */
    idx: integer("idx"),
    storedTxHash: text("stored_tx_hash"),
    /** When the first `store` finalized (renewals keep this; they move block and idx). */
    storedAt: timestamp("stored_at", { withTimezone: true }),
    /** Fee paid for the `store`, in planck (decimal string). */
    feePlanck: text("fee_planck"),
    lastRenewedAt: timestamp("last_renewed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("stored_items_object_chunk_idx").on(t.objectId, t.role, t.chunkIndex),
    index("stored_items_hash_idx").on(t.contentHash),
    index("stored_items_due_idx").on(t.status, t.block),
  ],
);

/**
 * Ciphertext the API accepted but the relayer has not finalized on chain yet. The worker reads it
 * from here (so API and worker share no disk) and deletes it once the store is finalized; the
 * gateway serves it meanwhile so a fresh upload is readable at once.
 */
export const blobStaging = pgTable("blob_staging", {
  storedItemId: uuid("stored_item_id")
    .primaryKey()
    .references(() => storedItems.id, { onDelete: "cascade" }),
  data: bytea("data").notNull(),
  createdAt: createdAt(),
});

export const renewals = pgTable(
  "renewals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    storedItemId: uuid("stored_item_id")
      .notNull()
      .references(() => storedItems.id),
    txHash: text("tx_hash").notNull(),
    fromBlock: integer("from_block").notNull(),
    fromIdx: integer("from_idx").notNull(),
    toBlock: integer("to_block").notNull(),
    toIdx: integer("to_idx").notNull(),
    feePlanck: text("fee_planck"),
    createdAt: createdAt(),
  },
  (t) => [index("renewals_item_idx").on(t.storedItemId)],
);

/** Raw chain metadata the indexer keeps per event, for rebuilds and proof pages. */
export const chainEvents = pgTable(
  "chain_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    source: text("source").notNull(),
    name: text("name").notNull(),
    block: integer("block").notNull(),
    txHash: text("tx_hash"),
    payload: jsonb("payload").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("chain_events_block_idx").on(t.source, t.block)],
);
