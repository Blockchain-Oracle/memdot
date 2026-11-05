import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { jobs } from "./access.js";
import { memoryEvent, memoryMode } from "./enums.js";
import { accounts, bytea, createdAt, folders, objects, spaces } from "./storage.js";

/** Assisted vectors have this many dimensions; every embedder is asked for this size. */
export const MEMORY_EMBEDDING_DIMENSIONS = 1536;

/**
 * One memory in a namespace (a folder in memory mode). The durable copy is an encrypted entry in a
 * segment on V3 (`segmentId`); this row is the index over it and can be rebuilt from the chain.
 *
 * Assisted rows carry what the server needs to search: scopes and metadata in the clear, a vector,
 * blinded keyword terms and the text sealed with a key only the server derives. It never stores
 * plaintext (R10). Private rows hold ids and tombstones only; everything else stays on the device.
 */
export const memories = pgTable(
  "memories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    spaceId: uuid("space_id")
      .notNull()
      .references(() => spaces.id),
    folderId: uuid("folder_id")
      .notNull()
      .references(() => folders.id),
    mode: memoryMode("mode").notNull(),
    version: integer("version").notNull().default(1),
    /** The segment holding the current version; null until it has been written. */
    segmentId: uuid("segment_id").references(() => objects.id),
    /** The file this was read from. Deleting the file deletes the memory (R8). */
    sourceObjectId: uuid("source_object_id").references(() => objects.id),
    sourceKind: text("source_kind"),
    sourceLabel: text("source_label"),
    userId: text("user_id"),
    agentId: text("agent_id"),
    runId: text("run_id"),
    metadata: jsonb("metadata"),
    categories: text("categories").array(),
    /** Blinded names the text mentions; a search naming one lifts this memory. */
    entityTerms: text("entity_terms").array(),
    memoryType: text("memory_type"),
    attributedTo: text("attributed_to"),
    /** Extraction failed, so the raw text was kept instead of distilled facts. */
    raw: boolean("raw").notNull().default(false),
    immutable: boolean("immutable").notNull().default(false),
    sealedText: bytea("sealed_text"),
    /** Blinded hash of (scope, normalized text), so the same fact isn't stored twice. */
    dedupeKey: text("dedupe_key"),
    embedding: vector("embedding", { dimensions: MEMORY_EMBEDDING_DIMENSIONS }),
    /** Vectors from different models aren't comparable; search only uses matching rows. */
    embeddingModel: text("embedding_model"),
    termCount: integer("term_count").notNull().default(0),
    feedback: text("feedback"),
    feedbackReason: text("feedback_reason"),
    /** Last returned by a search. With decay on, what's still in use keeps its place. */
    accessedAt: timestamp("accessed_at", { withTimezone: true, precision: 3 }),
    occurredAt: timestamp("occurred_at", { withTimezone: true, precision: 3 }),
    expiresAt: timestamp("expires_at", { withTimezone: true, precision: 3 }),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true, precision: 3 }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true, precision: 3 }),
  },
  (t) => [
    index("memories_folder_idx").on(t.folderId, t.createdAt, t.id),
    index("memories_account_idx").on(t.accountId, t.createdAt, t.id),
    index("memories_segment_idx").on(t.segmentId),
    index("memories_source_idx").on(t.sourceObjectId).where(sql`${t.sourceObjectId} is not null`),
    index("memories_user_idx").on(t.folderId, t.userId),
    index("memories_agent_idx").on(t.folderId, t.agentId),
    index("memories_run_idx").on(t.folderId, t.runId),
    index("memories_embedding_hnsw").using("hnsw", t.embedding.op("vector_cosine_ops")),
    uniqueIndex("memories_dedupe_idx")
      .on(t.folderId, t.dedupeKey)
      .where(sql`${t.dedupeKey} is not null and ${t.deletedAt} is null`),
  ],
);

/**
 * The keyword index: per memory, each term as a keyed hash with its count. The server can run BM25
 * over these without keeping a readable word.
 */
export const memoryTerms = pgTable(
  "memory_terms",
  {
    memoryId: uuid("memory_id")
      .notNull()
      .references(() => memories.id, { onDelete: "cascade" }),
    folderId: uuid("folder_id").notNull(),
    term: text("term").notNull(),
    count: integer("count").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.memoryId, t.term] }),
    index("memory_terms_lookup_idx").on(t.folderId, t.term),
  ],
);

/**
 * A stored segment of memories. Knowing how many entries it was written with tells the compactor
 * how much of it is dead. Assisted segments are written by the server, which can't sign for the
 * owner: `recordedAt` stays null until the owner's device adds them to the public registry.
 */
export const memorySegments = pgTable(
  "memory_segments",
  {
    objectId: uuid("object_id")
      .primaryKey()
      .references(() => objects.id),
    folderId: uuid("folder_id")
      .notNull()
      .references(() => folders.id),
    entries: integer("entries").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("memory_segments_folder_idx").on(t.folderId)],
);

/** What happened to an Assisted memory. Forgetting wipes the text and keeps the events. */
export const memoryHistory = pgTable(
  "memory_history",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    memoryId: uuid("memory_id")
      .notNull()
      .references(() => memories.id, { onDelete: "cascade" }),
    event: memoryEvent("event").notNull(),
    version: integer("version").notNull(),
    sealedText: bytea("sealed_text"),
    sealedPrevious: bytea("sealed_previous"),
    actor: text("actor"),
    createdAt: createdAt(),
  },
  (t) => [index("memory_history_memory_idx").on(t.memoryId, t.id)],
);

/**
 * A write waiting for the worker, sealed with the namespace's server key so the queue never holds
 * plaintext. Deleted as soon as the job finishes.
 */
export const memoryInbox = pgTable("memory_inbox", {
  jobId: uuid("job_id")
    .primaryKey()
    .references(() => jobs.id, { onDelete: "cascade" }),
  folderId: uuid("folder_id")
    .notNull()
    .references(() => folders.id),
  sealed: bytea("sealed").notNull(),
  createdAt: createdAt(),
});

/** Each account's calls on MemDot's shared model key, per UTC day. Its own key isn't counted. */
export const memoryModelUsage = pgTable(
  "memory_model_usage",
  {
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    day: date("day", { mode: "string" }).notNull(),
    modelCalls: integer("model_calls").notNull().default(0),
    searches: integer("searches").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.day] })],
);

/** A namespace's extraction settings. The server reads them for Assisted; Private seals them. */
export const memorySettings = pgTable("memory_settings", {
  folderId: uuid("folder_id")
    .primaryKey()
    .references(() => folders.id),
  customInstructions: text("custom_instructions"),
  categories: jsonb("categories"),
  /** Set: search favours what's been touched recently, with this half-life. Null: decay is off. */
  decayHalfLifeDays: integer("decay_half_life_days"),
  /** Private namespaces: the same settings, sealed on the device to the space key. */
  sealed: bytea("sealed"),
  keyEpoch: integer("key_epoch"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * An account's own model settings. The Assisted key is sealed with the server's key (it must use
 * it); the Private blob is sealed on the device to the account's key, and the server can't open it.
 */
export const memoryConfig = pgTable("memory_config", {
  accountId: uuid("account_id")
    .primaryKey()
    .references(() => accounts.id),
  llm: jsonb("llm"),
  llmKeySealed: bytea("llm_key_sealed"),
  embedder: jsonb("embedder"),
  embedderKeySealed: bytea("embedder_key_sealed"),
  privateSealed: bytea("private_sealed"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A generated summary of one person, regenerable at any time from their memories. Assisted: one row
 * per user, sealed with the namespace's server key. Private: one row holding all of them, sealed on
 * the device, so the server can't even see who has a profile.
 */
export const memoryProfiles = pgTable(
  "memory_profiles",
  {
    folderId: uuid("folder_id")
      .notNull()
      .references(() => folders.id, { onDelete: "cascade" }),
    /** The user id, or `PRIVATE_PROFILES_SUBJECT` for a Private namespace's one sealed row. */
    subject: text("subject").notNull(),
    sealed: bytea("sealed").notNull(),
    memoriesRead: integer("memories_read").notNull().default(0),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.folderId, t.subject] })],
);

export const PRIVATE_PROFILES_SUBJECT = "*private*";

/** Where to tell an account about what happened. Its signing secret is shown once, then sealed. */
export const webhooks = pgTable(
  "webhooks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    name: text("name").notNull(),
    url: text("url").notNull(),
    events: text("events").array().notNull(),
    secretSealed: bytea("secret_sealed").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("webhooks_account_idx").on(t.accountId)],
);

/** One event for one webhook, and how it went. Ids only (R10), never anything a memory says. */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    webhookId: uuid("webhook_id")
      .notNull()
      .references(() => webhooks.id, { onDelete: "cascade" }),
    event: text("event").notNull(),
    payload: jsonb("payload").notNull(),
    /** pending, delivered or failed. */
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    responseStatus: integer("response_status"),
    latencyMs: integer("latency_ms"),
    error: text("error"),
    createdAt: createdAt(),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  },
  (t) => [index("webhook_deliveries_webhook_idx").on(t.webhookId, t.createdAt)],
);
