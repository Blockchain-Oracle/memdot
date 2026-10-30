import { randomUUID } from "node:crypto";
import { createRoute, z } from "@hono/zod-openapi";
import {
  contentHash,
  contentHashFromCid,
  extrinsicHashes,
  storageEventsAt,
  toHex,
} from "@memdot/chain";
import {
  CHUNK_BYTES,
  IDEMPOTENCY_HEADER,
  MAX_SEGMENT_ENTRIES,
  MAX_SYSTEM_OBJECT_BYTES,
  MAX_SYSTEM_OBJECTS,
  RENEW_AT_FRACTION,
  RENEW_NOW_MIN_AGE_BLOCKS,
  RETENTION_BLOCKS,
} from "@memdot/config";
import { blobStaging, jobs, objects, spaces, storedItems } from "@memdot/db";
import {
  enqueueChainTx,
  JOB_KIND,
  jobEventOf,
  openJobsOf,
  RENEW_BATCH_SIZE,
  settleObject,
  updateJob,
} from "@memdot/jobs";
import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNull,
  lte,
  min,
  ne,
  notExists,
  notInArray,
  type SQL,
  sql,
} from "drizzle-orm";
import { bodyLimit } from "hono/body-limit";
import { db } from "../db.js";
import { env } from "../env.js";
import {
  badRequest,
  conflict,
  forbidden,
  HttpError,
  isUniqueViolation,
  notFound,
} from "../lib/errors.js";
import { tombstoneObjects } from "../lib/lifecycle.js";
import { loadFolder, loadObject, loadSpace } from "../lib/ownership.js";
import { afterCursor, newestFirst, page } from "../lib/pagination.js";
import { accountOf, isAccountWide, principalOf, requireScope } from "../lib/principal.js";
import { authenticated, createRouter, errorResponses, jsonContent } from "../lib/router.js";
import { sponsoredStoragePaused } from "../lib/storage-status.js";
import { Cid, fromBase64, IdParam, PageQuery, pageOf, SealedText, toBase64 } from "../schemas.js";
import type { Services } from "../types.js";
import { Job } from "./jobs.js";

/** Account objects: outside any space and quota, always relayed, and small. */
const SYSTEM_KINDS = new Set(["key_bundle", "grant_key"]);
/** Kinds whose bytes may span several chunks under one root. */
const CHUNKED_KINDS = new Set(["file", "index_snapshot"]);

const Kind = z.enum(["file", "segment", "index_snapshot", "key_bundle", "grant_key"]);
const Role = z.enum(["root", "chunk"]);
const BlobRef = z.object({ cid: Cid, size: z.number().int().min(1).max(CHUNK_BYTES) });

const Blob = z
  .object({
    role: Role,
    index: z.number().int(),
    cid: z.string(),
    sizeBytes: z.number().int(),
    status: z.enum(["pending", "stored", "expired_served", "lost", "released"]),
    staged: z
      .boolean()
      .openapi({ description: "The API holds the ciphertext, waiting to store it" }),
    block: z.number().int().nullable(),
    indexInBlock: z.number().int().nullable(),
    txHash: z.string().nullable(),
    feePlanck: z.string().nullable(),
    expiresAtBlock: z.number().int().nullable(),
    renewDueAtBlock: z.number().int().nullable(),
  })
  .openapi("Blob");

export const StoredObject = z
  .object({
    id: z.uuid(),
    spaceId: z.uuid().nullable(),
    folderId: z.uuid().nullable(),
    kind: Kind.or(z.literal("manifest")),
    status: z.enum(["queued", "uploading", "stored", "failed", "tombstoned", "lost"]),
    cid: z.string().nullable(),
    sizeBytes: z.number().int(),
    encryptedMeta: z.string().nullable(),
    segmentId: z.uuid().nullable(),
    previousVersionId: z.uuid().nullable(),
    keyEpoch: z.number().int().nullable(),
    createdAt: z.iso.datetime(),
    tombstonedAt: z.iso.datetime().nullable(),
  })
  .openapi("Object");

/** In lists: when the object's earliest blob leaves the chain (a segment entry: its segment's). */
const ListedObject = StoredObject.extend({
  expiresAtBlock: z.number().int().nullable(),
}).openapi("ListedObject");

const ObjectPage = pageOf(ListedObject)
  .extend({ headBlock: z.number().int().nullable() })
  .openapi("ObjectPage");

export const ObjectDetail = StoredObject.extend({
  blobs: z.array(Blob),
  headBlock: z.number().int().nullable(),
}).openapi("ObjectDetail");

const Upload = z.object({
  role: Role,
  index: z.number().int(),
  cid: z.string(),
  size: z.number().int(),
  url: z.string().openapi({ description: "PUT the ciphertext here as application/octet-stream" }),
});

const Declared = z
  .object({ object: StoredObject, job: Job, uploads: z.array(Upload) })
  .openapi("DeclaredObject");

const NewObject = z
  .object({
    kind: Kind,
    spaceId: z
      .uuid()
      .optional()
      .openapi({ description: "Required except for key bundles and grant keys" }),
    folderId: z.uuid().optional(),
    encryptedMeta: SealedText.optional(),
    sizeBytes: z.number().int().min(0).openapi({ description: "Padded plaintext size" }),
    root: BlobRef.openapi({ description: "The manifest, segment or bundle that names the rest" }),
    chunks: z.array(BlobRef).max(64).default([]),
    previousVersionId: z
      .uuid()
      .optional()
      .openapi({ description: "Makes this a new version of that file" }),
    keyEpoch: z.number().int().min(0).optional().openapi({
      description:
        "The space key epoch the manifest and metadata are sealed with. Required for space objects; must be the space's current epoch.",
    }),
  })
  .openapi("NewObject");

type ObjectRow = typeof objects.$inferSelect;
type StoredItemRow = typeof storedItems.$inferSelect;

export const serializeObject = (row: ObjectRow) => ({
  id: row.id,
  spaceId: row.spaceId,
  folderId: row.folderId,
  kind: row.kind,
  status: row.status,
  cid: row.cid,
  sizeBytes: row.sizeBytes,
  encryptedMeta: toBase64(row.encryptedMeta),
  segmentId: row.segmentId,
  previousVersionId: row.previousVersionId,
  keyEpoch: row.keyEpoch,
  createdAt: row.createdAt.toISOString(),
  tombstonedAt: row.tombstonedAt?.toISOString() ?? null,
});

export function serializeBlob(row: StoredItemRow, staged: boolean) {
  return {
    role: row.role,
    index: row.chunkIndex,
    cid: row.cid,
    sizeBytes: row.sizeBytes,
    status: row.status,
    staged,
    block: row.block,
    indexInBlock: row.idx,
    txHash: row.storedTxHash,
    feePlanck: row.feePlanck,
    expiresAtBlock: row.block === null ? null : row.block + RETENTION_BLOCKS,
    renewDueAtBlock:
      row.block === null ? null : row.block + Math.floor(RETENTION_BLOCKS * RENEW_AT_FRACTION),
  };
}

/** Each object's soonest expiry over its live blobs (stored, or expired but still served). */
async function earliestExpiries(objectIds: string[]): Promise<Map<string, number>> {
  if (objectIds.length === 0) return new Map();
  const rows = await db
    .select({ objectId: storedItems.objectId, block: min(storedItems.block) })
    .from(storedItems)
    .where(
      and(
        inArray(storedItems.objectId, [...new Set(objectIds)]),
        inArray(storedItems.status, ["stored", "expired_served"]),
      ),
    )
    .groupBy(storedItems.objectId);
  return new Map(
    rows.flatMap((row) =>
      row.objectId && row.block !== null ? [[row.objectId, row.block + RETENTION_BLOCKS]] : [],
    ),
  );
}

const uploadUrl = (objectId: string, role: string, index: number) =>
  `/v1/objects/${objectId}/blobs/${role}/${index}`;

/** Blobs in store order: data chunks first, then the root that lists them. */
export const storeOrder = (items: StoredItemRow[]) =>
  [...items].sort((a, b) =>
    a.role === b.role ? a.chunkIndex - b.chunkIndex : a.role === "chunk" ? -1 : 1,
  );

type Executor = Pick<typeof db, "select">;

/** The job that follows an object's first store. Pass the open transaction when inside one. */
async function storeJobOf(executor: Executor, objectId: string) {
  const [job] = await executor
    .select()
    .from(jobs)
    .where(and(eq(jobs.objectId, objectId), eq(jobs.kind, JOB_KIND.storeObject)))
    .limit(1);
  return job ?? null;
}

async function declaredResponse(objectId: string) {
  const [object] = await db.select().from(objects).where(eq(objects.id, objectId));
  const job = await storeJobOf(db, objectId);
  if (!object || !job) throw notFound("Object");
  const items = await db.select().from(storedItems).where(eq(storedItems.objectId, objectId));
  return {
    object: serializeObject(object),
    job: jobEventOf(job),
    uploads: storeOrder(items).map((item) => ({
      role: item.role,
      index: item.chunkIndex,
      cid: item.cid,
      size: item.sizeBytes,
      url: uploadUrl(objectId, item.role, item.chunkIndex),
    })),
  };
}

export function objectRoutes(services: Services) {
  return createRouter()
    .openapi(
      createRoute({
        method: "post",
        path: "/v1/objects",
        tags: ["Objects"],
        summary: "Declare an encrypted object and get its upload slots",
        description:
          "The client encrypts, chunks and computes every CID first. Sponsored writes reserve quota here, before any tPOT is spent. Send an Idempotency-Key to make retries safe.",
        security: authenticated,
        middleware: [requireScope("files", "write")] as const,
        request: {
          headers: z.object({ [IDEMPOTENCY_HEADER]: z.string().max(128).optional() }),
          body: { content: jsonContent(NewObject), required: true },
        },
        responses: {
          202: { description: "Declared; upload each slot", content: jsonContent(Declared) },
          200: { description: "Replayed (same Idempotency-Key)", content: jsonContent(Declared) },
          ...errorResponses,
        },
      }),
      async (c) => {
        const accountId = accountOf(c);
        const body = c.req.valid("json");
        const idempotencyKey = c.req.valid("header")[IDEMPOTENCY_HEADER] ?? null;
        const system = SYSTEM_KINDS.has(body.kind);
        if (system && !isAccountWide(principalOf(c))) {
          throw forbidden("Key bundles and grant keys need the dashboard or an account-wide key.");
        }

        if (idempotencyKey) {
          const [replay] = await db
            .select({ objectId: jobs.objectId })
            .from(jobs)
            .where(and(eq(jobs.accountId, accountId), eq(jobs.idempotencyKey, idempotencyKey)))
            .limit(1);
          const objectId = replay?.objectId;
          if (objectId) {
            await loadObject(c, objectId);
            return c.json(await declaredResponse(objectId), 200);
          }
        }

        const blobs = [
          { role: "root" as const, index: 0, ...body.root },
          ...body.chunks.map((chunk, index) => ({ role: "chunk" as const, index, ...chunk })),
        ];
        const total = blobs.reduce((sum, blob) => sum + blob.size, 0);
        if (body.chunks.length > 0 && !CHUNKED_KINDS.has(body.kind)) {
          throw badRequest("NO_CHUNKS", `A ${body.kind} is a single blob; send it as the root.`);
        }
        if (body.kind === "file" && body.chunks.length === 0) {
          throw badRequest(
            "FILE_CHUNKS",
            "A file needs its manifest as the root and at least one data chunk.",
          );
        }
        if (system && (body.spaceId || body.folderId)) {
          throw badRequest(
            "SYSTEM_OBJECT",
            "Key bundles and grant keys belong to the account, not a space.",
          );
        }
        if (system && total > MAX_SYSTEM_OBJECT_BYTES) {
          throw badRequest(
            "TOO_LARGE",
            `Key bundles and grant keys are at most ${MAX_SYSTEM_OBJECT_BYTES} bytes.`,
          );
        }
        if (total > env.MAX_FILE_BYTES) {
          throw badRequest(
            "TOO_LARGE",
            `Objects are at most ${env.MAX_FILE_BYTES} bytes of ciphertext.`,
          );
        }

        const space = system ? null : body.spaceId ? await loadSpace(c, body.spaceId) : null;
        if (!system && !space)
          throw badRequest("SPACE_REQUIRED", "Choose the space to store this in.");
        if (body.folderId) {
          const folder = await loadFolder(c, body.folderId);
          if (folder.spaceId !== space?.id)
            throw badRequest("FOLDER_SPACE", "That folder is in another space.");
        }
        if (body.previousVersionId) {
          const previous = await loadObject(c, body.previousVersionId);
          if (
            previous.spaceId !== space?.id ||
            previous.kind !== body.kind ||
            previous.status === "tombstoned"
          ) {
            throw badRequest(
              "VERSION",
              "A new version must follow a live object of the same kind in the same space.",
            );
          }
        }
        if (system) {
          const [live] = await db
            .select({ n: count() })
            .from(objects)
            .where(
              and(
                eq(objects.accountId, accountId),
                inArray(objects.kind, ["key_bundle", "grant_key"]),
                notInArray(objects.status, ["tombstoned", "failed"]),
              ),
            );
          if ((live?.n ?? 0) >= MAX_SYSTEM_OBJECTS) {
            throw conflict(
              "SYSTEM_OBJECT_LIMIT",
              `An account can keep ${MAX_SYSTEM_OBJECTS} key bundles and grant keys; delete old ones first.`,
            );
          }
        }
        // Decided once, here: later mode switches on the space never change who pays.
        if (space) {
          // New writes use the current epoch: a client that missed a rotation must not keep
          // sealing with a key a revoked grantee still holds.
          if (body.keyEpoch !== space.keyEpoch) {
            throw new HttpError(
              409,
              "KEY_EPOCH_STALE",
              "The space key moved to a new epoch. Seal with the current one.",
              { keyEpoch: space.keyEpoch },
            );
          }
        }
        const relayed = system || space?.mode === "sponsored";
        const reservedBytes = space && relayed ? total : 0;
        if (relayed && (await sponsoredStoragePaused())) {
          throw new HttpError(
            503,
            "STORAGE_PAUSED",
            "Sponsored storage is paused while MemDot's relayer is topped up. Stored files are safe and renewals continue; try again later or use a self-signed space.",
          );
        }
        const objectId = randomUUID();

        try {
          await db.transaction(async (tx) => {
            if (space && reservedBytes > 0) {
              const reserved = await tx
                .update(spaces)
                .set({ usedBytes: sql`${spaces.usedBytes} + ${reservedBytes}` })
                .where(
                  and(
                    eq(spaces.id, space.id),
                    sql`${spaces.usedBytes} + ${reservedBytes} <= ${spaces.quotaBytes}`,
                  ),
                )
                .returning({ id: spaces.id });
              if (reserved.length === 0) {
                throw new HttpError(
                  409,
                  "QUOTA_EXCEEDED",
                  "This upload would exceed the space's quota.",
                  {
                    quotaBytes: space.quotaBytes,
                    usedBytes: space.usedBytes,
                    requestedBytes: total,
                  },
                );
              }
            }
            await tx.insert(objects).values({
              id: objectId,
              accountId,
              spaceId: space?.id ?? null,
              folderId: body.folderId ?? null,
              kind: body.kind,
              status: "queued",
              contentHash: toHex(contentHashFromCid(body.root.cid)),
              cid: body.root.cid,
              sizeBytes: body.sizeBytes,
              encryptedMeta: body.encryptedMeta ? fromBase64(body.encryptedMeta) : null,
              previousVersionId: body.previousVersionId ?? null,
              relayed,
              reservedBytes,
              keyEpoch: space ? space.keyEpoch : null,
            });
            await tx.insert(storedItems).values(
              blobs.map((blob) => ({
                objectId,
                accountId,
                role: blob.role,
                chunkIndex: blob.index,
                contentHash: toHex(contentHashFromCid(blob.cid)),
                cid: blob.cid,
                sizeBytes: blob.size,
              })),
            );
            await tx.insert(jobs).values({
              accountId,
              objectId,
              kind: JOB_KIND.storeObject,
              idempotencyKey,
              payload: { objectId },
              result: { progress: { done: 0, total: blobs.length } },
            });
          });
        } catch (error) {
          // A concurrent retry with the same key lost the race: Postgres held its insert until the
          // winner committed, so the winner's object is there to replay (it may collide on the
          // ciphertext first, since the object row is written before the job row).
          const raced =
            isUniqueViolation(error, "jobs_idempotency_idx") ||
            isUniqueViolation(error, "objects_space_hash_idx");
          if (idempotencyKey && raced) {
            const [winner] = await db
              .select({ objectId: jobs.objectId })
              .from(jobs)
              .where(and(eq(jobs.accountId, accountId), eq(jobs.idempotencyKey, idempotencyKey)));
            const winnerId = winner?.objectId;
            if (winnerId) {
              await loadObject(c, winnerId);
              return c.json(await declaredResponse(winnerId), 200);
            }
          }
          if (isUniqueViolation(error, "objects_space_hash_idx")) {
            throw conflict(
              "DUPLICATE_OBJECT",
              "This exact ciphertext is already stored in the space.",
            );
          }
          throw error;
        }
        return c.json(await declaredResponse(objectId), 202);
      },
    )
    .openapi(
      createRoute({
        method: "put",
        path: "/v1/objects/{id}/blobs/{role}/{index}",
        tags: ["Objects"],
        summary: "Upload one blob's ciphertext",
        description:
          "The bytes must hash to the declared CID. When the last blob arrives, sponsored objects go to the relayer's queue.",
        security: authenticated,
        middleware: [requireScope("files", "write"), bodyLimit({ maxSize: CHUNK_BYTES })] as const,
        request: {
          params: z.object({
            id: z.uuid().openapi({ param: { name: "id", in: "path" } }),
            role: Role.openapi({ param: { name: "role", in: "path" } }),
            index: z.coerce
              .number()
              .int()
              .min(0)
              .openapi({ param: { name: "index", in: "path" } }),
          }),
          body: {
            content: {
              "application/octet-stream": { schema: z.string().openapi({ format: "binary" }) },
            },
            required: true,
          },
        },
        responses: {
          200: {
            description: "Received",
            content: jsonContent(
              z.object({ received: z.literal(true), remaining: z.number().int() }),
            ),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        const { id, role, index } = c.req.valid("param");
        const object = await loadObject(c, id);
        if (!object.relayed) {
          throw conflict(
            "SELF_SIGNED",
            "This object is in a self-signed space: store each blob with your wallet, then record it at …/stored.",
          );
        }
        const [item] = await db
          .select()
          .from(storedItems)
          .where(
            and(
              eq(storedItems.objectId, id),
              eq(storedItems.role, role),
              eq(storedItems.chunkIndex, index),
            ),
          );
        if (!item) throw notFound("Blob");

        const pendingWithoutBytes = (objectId: string) =>
          and(
            eq(storedItems.objectId, objectId),
            eq(storedItems.status, "pending"),
            notExists(
              db.select().from(blobStaging).where(eq(blobStaging.storedItemId, storedItems.id)),
            ),
          );

        if (item.status !== "pending") {
          const left = await db.$count(storedItems, pendingWithoutBytes(id));
          return c.json({ received: true as const, remaining: left }, 200);
        }

        const bytes = new Uint8Array(await c.req.arrayBuffer());
        if (bytes.length !== item.sizeBytes) {
          throw badRequest(
            "SIZE_MISMATCH",
            `Expected ${item.sizeBytes} bytes, got ${bytes.length}.`,
          );
        }
        if (toHex(contentHash(bytes)) !== item.contentHash) {
          throw badRequest("INTEGRITY", "These bytes do not match the CID declared for this slot.");
        }

        const remaining = await db.transaction(async (tx) => {
          // The row lock orders concurrent uploads, so only one of them sees the last blob land.
          const [current] = await tx
            .select({ status: objects.status })
            .from(objects)
            .where(eq(objects.id, id))
            .for("update");
          if (current?.status !== "queued") {
            throw conflict(
              "NOT_ACCEPTING_UPLOADS",
              `This object is ${current?.status ?? "gone"}; it no longer takes uploads.`,
            );
          }
          await tx
            .insert(blobStaging)
            .values({ storedItemId: item.id, data: bytes })
            .onConflictDoNothing();
          const left = await tx.$count(storedItems, pendingWithoutBytes(id));
          if (left === 0) {
            const job = await storeJobOf(tx, id);
            if (!job) throw new Error(`object ${id} has no store job`);
            const items = await tx
              .select()
              .from(storedItems)
              .where(and(eq(storedItems.objectId, id), eq(storedItems.status, "pending")));
            for (const pending of storeOrder(items)) {
              await enqueueChainTx(services.boss, tx, {
                action: "store",
                jobId: job.id,
                storedItemId: pending.id,
              });
            }
            await tx.update(objects).set({ status: "uploading" }).where(eq(objects.id, id));
            await updateJob(tx, job.id, { status: "queued" });
          }
          return left;
        });
        return c.json({ received: true as const, remaining }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/v1/objects",
        tags: ["Objects"],
        summary: "List objects",
        security: authenticated,
        middleware: [requireScope("files", "read")] as const,
        request: {
          query: PageQuery.extend({
            spaceId: z.uuid().optional(),
            folderId: z
              .union([z.uuid(), z.literal("root")])
              .optional()
              .openapi({
                description: "A folder id, or `root` for objects outside any folder",
              }),
            kind: Kind.optional(),
            status: StoredObject.shape.status.optional(),
          }),
        },
        responses: {
          200: { description: "Objects", content: jsonContent(ObjectPage) },
          ...errorResponses,
        },
      }),
      async (c) => {
        const accountId = accountOf(c);
        const query = c.req.valid("query");
        if (query.spaceId) await loadSpace(c, query.spaceId);
        const allowed = principalOf(c).apiKey?.spaceIds;
        const filters: (SQL | undefined)[] = [
          eq(objects.accountId, accountId),
          query.spaceId ? eq(objects.spaceId, query.spaceId) : undefined,
          allowed ? inArray(objects.spaceId, allowed) : undefined,
          query.folderId === "root"
            ? isNull(objects.folderId)
            : query.folderId
              ? eq(objects.folderId, query.folderId)
              : undefined,
          query.kind ? eq(objects.kind, query.kind) : undefined,
          query.status ? eq(objects.status, query.status) : ne(objects.status, "tombstoned"),
          afterCursor(query.cursor, objects.createdAt, objects.id),
        ];
        const rows = await db
          .select()
          .from(objects)
          .where(and(...filters))
          .orderBy(...newestFirst(objects.createdAt, objects.id))
          .limit(query.limit + 1);
        const result = page(rows, query.limit);
        const expiries = await earliestExpiries(result.items.map((row) => row.segmentId ?? row.id));
        return c.json(
          {
            items: result.items.map((row) => ({
              ...serializeObject(row),
              expiresAtBlock: expiries.get(row.segmentId ?? row.id) ?? null,
            })),
            nextCursor: result.nextCursor,
            headBlock: services.chainHead.block,
          },
          200,
        );
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/v1/objects/{id}",
        tags: ["Objects"],
        summary: "An object with every blob's location, renewal and fee",
        security: authenticated,
        middleware: [requireScope("files", "read")] as const,
        request: { params: IdParam },
        responses: {
          200: { description: "Object", content: jsonContent(ObjectDetail) },
          ...errorResponses,
        },
      }),
      async (c) => {
        const object = await loadObject(c, c.req.valid("param").id);
        const items = await db
          .select({
            item: storedItems,
            staged: sql<boolean>`${blobStaging.storedItemId} is not null`,
          })
          .from(storedItems)
          .leftJoin(blobStaging, eq(blobStaging.storedItemId, storedItems.id))
          .where(eq(storedItems.objectId, object.id))
          .orderBy(asc(storedItems.role), asc(storedItems.chunkIndex));
        return c.json(
          {
            ...serializeObject(object),
            blobs: items.map((row) => serializeBlob(row.item, row.staged)),
            headBlock: services.chainHead.block,
          },
          200,
        );
      },
    )
    .openapi(
      createRoute({
        method: "patch",
        path: "/v1/objects/{id}",
        tags: ["Objects"],
        summary: "Rename (new sealed metadata) or move to another folder",
        description: "Only metadata changes; the stored bytes are not re-uploaded.",
        security: authenticated,
        middleware: [requireScope("files", "write")] as const,
        request: {
          params: IdParam,
          body: {
            content: jsonContent(
              z.object({
                encryptedMeta: SealedText.optional(),
                folderId: z.uuid().nullable().optional(),
              }),
            ),
            required: true,
          },
        },
        responses: {
          200: { description: "Object", content: jsonContent(StoredObject) },
          ...errorResponses,
        },
      }),
      async (c) => {
        const object = await loadObject(c, c.req.valid("param").id);
        if (object.status === "tombstoned")
          throw conflict("TOMBSTONED", "This object was deleted.");
        const body = c.req.valid("json");
        if (body.folderId) {
          const folder = await loadFolder(c, body.folderId);
          if (folder.spaceId !== object.spaceId)
            throw badRequest("FOLDER_SPACE", "That folder is in another space.");
        }
        const [row] = await db
          .update(objects)
          .set({
            ...(body.encryptedMeta ? { encryptedMeta: fromBase64(body.encryptedMeta) } : {}),
            ...(body.folderId !== undefined ? { folderId: body.folderId } : {}),
          })
          .where(eq(objects.id, object.id))
          .returning();
        if (!row) throw notFound("Object");
        return c.json(serializeObject(row), 200);
      },
    )
    .openapi(
      createRoute({
        method: "delete",
        path: "/v1/objects/{id}",
        tags: ["Objects"],
        summary: "Delete an object",
        description:
          "Tombstones it and stops renewing. The bytes expire from the chain within 7 days; earlier downloads or shares cannot be undone. Deleting a segment deletes every entry in it.",
        security: authenticated,
        middleware: [requireScope("files", "write")] as const,
        request: { params: IdParam },
        responses: {
          200: {
            description: "Deleted",
            content: jsonContent(z.object({ deleted: z.number().int() })),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        const object = await loadObject(c, c.req.valid("param").id);
        const deleted = await db.transaction((tx) =>
          tombstoneObjects(
            tx,
            sql`(${objects.id} = ${object.id} or ${objects.segmentId} = ${object.id})`,
          ),
        );
        return c.json({ deleted }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/v1/objects/{id}/versions",
        tags: ["Objects"],
        summary: "Every version of a file, newest first",
        security: authenticated,
        middleware: [requireScope("files", "read")] as const,
        request: { params: IdParam },
        responses: {
          200: {
            description: "Versions",
            content: jsonContent(z.object({ items: z.array(StoredObject) })),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        const object = await loadObject(c, c.req.valid("param").id);
        const result = await db.execute<{ id: string }>(sql`
          with recursive older as (
            select id, previous_version_id from objects where id = ${object.id}
            union all
            select o.id, o.previous_version_id from objects o join older on o.id = older.previous_version_id
          ), newer as (
            select id from objects where id = ${object.id}
            union all
            select o.id from objects o join newer on o.previous_version_id = newer.id
          )
          select id from older union select id from newer`);
        const ids = result.rows.map((row) => row.id);
        const rows = await db
          .select()
          .from(objects)
          .where(and(inArray(objects.id, ids), eq(objects.accountId, object.accountId)))
          .orderBy(...newestFirst(objects.createdAt, objects.id));
        return c.json({ items: rows.map(serializeObject) }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/v1/objects/{id}/renew",
        tags: ["Objects"],
        summary: "Renew now",
        description:
          "Moves every stored blob to a fresh 7-day window; the CID stays the same. The keeper does this automatically at 80% of retention.",
        security: authenticated,
        middleware: [requireScope("files", "write")] as const,
        request: { params: IdParam },
        responses: { 202: { description: "Queued", content: jsonContent(Job) }, ...errorResponses },
      }),
      async (c) => {
        const object = await loadObject(c, c.req.valid("param").id);
        const [open] = await db
          .select()
          .from(jobs)
          .where(
            and(
              eq(jobs.objectId, object.id),
              eq(jobs.kind, JOB_KIND.renew),
              notInArray(jobs.status, ["finalized", "failed"]),
            ),
          )
          .limit(1);
        // One "Renew now" at a time per object: a second click follows the first.
        if (open) return c.json(jobEventOf(open), 202);
        const head = services.chainHead.block;
        if (head === null)
          throw new HttpError(503, "CHAIN_UNAVAILABLE", "Portaldot V3 is not reachable right now.");
        const items = (
          await db
            .select({ id: storedItems.id, block: storedItems.block })
            .from(storedItems)
            .where(
              and(
                eq(storedItems.objectId, object.id),
                eq(storedItems.status, "stored"),
                // Freshly stored or renewed blobs have nearly all their 7 days left.
                lte(storedItems.block, head - RENEW_NOW_MIN_AGE_BLOCKS),
              ),
            )
        ).flatMap((item) => (item.block === null ? [] : [{ id: item.id, atBlock: item.block }]));
        if (items.length === 0) {
          throw conflict(
            "NOTHING_DUE",
            "Every stored part of this object was stored or renewed within the last hour.",
          );
        }
        const job = await db.transaction(async (tx) => {
          const [row] = await tx
            .insert(jobs)
            .values({
              accountId: object.accountId,
              objectId: object.id,
              kind: JOB_KIND.renew,
              payload: { objectId: object.id },
              result: { progress: { done: 0, total: items.length } },
            })
            .returning();
          if (!row) throw new Error("job insert returned no row");
          await tx
            .update(storedItems)
            .set({ renewQueuedAt: new Date() })
            .where(
              inArray(
                storedItems.id,
                items.map((item) => item.id),
              ),
            );
          for (let i = 0; i < items.length; i += RENEW_BATCH_SIZE) {
            await enqueueChainTx(services.boss, tx, {
              action: "renew",
              jobId: row.id,
              items: items.slice(i, i + RENEW_BATCH_SIZE),
            });
          }
          return row;
        });
        return c.json(jobEventOf(job), 202);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/v1/objects/{id}/entries",
        tags: ["Objects"],
        summary: "Register the tiny files packed inside a segment",
        description:
          "Files under 64 KiB share one stored segment. Each entry becomes a file object pointing at the segment, so it lists, renames and deletes like any file while one blob is renewed for all of them.",
        security: authenticated,
        middleware: [requireScope("files", "write")] as const,
        request: {
          params: IdParam,
          body: {
            content: jsonContent(
              z.object({
                entries: z
                  .array(
                    z.object({
                      id: z.uuid().optional().openapi({
                        description: "Client-chosen id, as written in the segment's index",
                      }),
                      folderId: z.uuid().optional(),
                      encryptedMeta: SealedText,
                      sizeBytes: z.number().int().min(0),
                    }),
                  )
                  .min(1)
                  .max(MAX_SEGMENT_ENTRIES),
              }),
            ),
            required: true,
          },
        },
        responses: {
          201: {
            description: "Entries",
            content: jsonContent(z.object({ items: z.array(StoredObject) })),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        const segment = await loadObject(c, c.req.valid("param").id);
        if (segment.kind !== "segment" || !segment.spaceId) {
          throw badRequest("NOT_A_SEGMENT", "Entries can only be added to a segment in a space.");
        }
        const { entries } = c.req.valid("json");
        const folderIds = [...new Set(entries.flatMap((e) => (e.folderId ? [e.folderId] : [])))];
        for (const folderId of folderIds) {
          const folder = await loadFolder(c, folderId);
          if (folder.spaceId !== segment.spaceId)
            throw badRequest("FOLDER_SPACE", "That folder is in another space.");
        }
        const rows = await db
          .insert(objects)
          .values(
            entries.map((entry) => ({
              ...(entry.id ? { id: entry.id } : {}),
              accountId: segment.accountId,
              spaceId: segment.spaceId,
              folderId: entry.folderId ?? null,
              kind: "file" as const,
              status: segment.status,
              keyEpoch: segment.keyEpoch,
              sizeBytes: entry.sizeBytes,
              encryptedMeta: fromBase64(entry.encryptedMeta),
              segmentId: segment.id,
            })),
          )
          .returning();
        return c.json({ items: rows.map(serializeObject) }, 201);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/v1/objects/{id}/blobs/{role}/{index}/stored",
        tags: ["Objects"],
        summary: "Record a store your wallet signed (self-signed spaces)",
        description:
          "The API checks the finalized block's TransactionStorage events for this blob's content hash at the given location before recording it.",
        security: authenticated,
        middleware: [requireScope("files", "write")] as const,
        request: {
          params: z.object({
            id: z.uuid().openapi({ param: { name: "id", in: "path" } }),
            role: Role.openapi({ param: { name: "role", in: "path" } }),
            index: z.coerce
              .number()
              .int()
              .min(0)
              .openapi({ param: { name: "index", in: "path" } }),
          }),
          body: {
            content: jsonContent(
              z.object({
                block: z.number().int().positive(),
                indexInBlock: z.number().int().min(0).openapi({
                  description:
                    "The Stored event's index; the tx hash and fee are read from the chain",
                }),
              }),
            ),
            required: true,
          },
        },
        responses: {
          200: { description: "Object", content: jsonContent(ObjectDetail) },
          ...errorResponses,
        },
      }),
      async (c) => {
        const { id, role, index } = c.req.valid("param");
        const body = c.req.valid("json");
        const object = await loadObject(c, id);
        if (object.relayed) {
          throw badRequest(
            "SPONSORED",
            "MemDot's relayer stores this object; there is nothing to record.",
          );
        }
        if (object.status !== "queued" && object.status !== "uploading") {
          throw conflict("NOT_ACCEPTING_UPLOADS", `This object is ${object.status}.`);
        }
        const [item] = await db
          .select()
          .from(storedItems)
          .where(
            and(
              eq(storedItems.objectId, id),
              eq(storedItems.role, role),
              eq(storedItems.chunkIndex, index),
            ),
          );
        if (!item) throw notFound("Blob");
        if (item.status !== "pending") {
          throw conflict("ALREADY_RECORDED", "This blob's store is already recorded.");
        }
        const head = services.chainHead.block;
        if (head === null || body.block > head) {
          throw conflict(
            "NOT_FINALIZED",
            "That block is not finalized yet. Record the store once it is.",
          );
        }
        const events = await storageEventsAt(services.chain, body.block);
        const match = events.find(
          (event) =>
            event.kind === "stored" &&
            event.index === body.indexInBlock &&
            toHex(event.contentHash) === item.contentHash,
        );
        if (!match) {
          throw badRequest("NOT_ON_CHAIN", "No store of these bytes at that block and index.");
        }
        // The proof page shows this hash, so it comes from the chain, never from the client.
        const txHash =
          match.extrinsicIndex === null
            ? null
            : ((await extrinsicHashes(services.chain, body.block))[match.extrinsicIndex] ?? null);
        await db.transaction(async (tx) => {
          const recorded = await tx
            .update(storedItems)
            .set({
              status: "stored",
              block: body.block,
              idx: body.indexInBlock,
              firstBlock: body.block,
              firstIdx: body.indexInBlock,
              storedTxHash: txHash,
              storedAt: new Date(),
              feePlanck: match.feePlanck?.toString() ?? null,
            })
            .where(and(eq(storedItems.id, item.id), eq(storedItems.status, "pending")))
            .returning({ id: storedItems.id });
          if (recorded.length === 0) return;
          await tx
            .update(objects)
            .set({ status: "uploading" })
            .where(and(eq(objects.id, id), eq(objects.status, "queued")));
          await settleObject(tx, id, await openJobsOf(tx, id));
        });
        const [updated] = await db.select().from(objects).where(eq(objects.id, id));
        const items = await db.select().from(storedItems).where(eq(storedItems.objectId, id));
        if (!updated) throw notFound("Object");
        return c.json(
          {
            ...serializeObject(updated),
            blobs: storeOrder(items).map((row) => serializeBlob(row, false)),
            headBlock: head,
          },
          200,
        );
      },
    );
}
