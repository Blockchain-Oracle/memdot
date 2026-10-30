import { createRoute, z } from "@hono/zod-openapi";
import { accounts, agents, grants, objects, spaces, storedItems } from "@memdot/db";
import { and, asc, eq, inArray, isNull, type SQL } from "drizzle-orm";
import type { Context } from "hono";
import { db } from "../db.js";
import { HttpError, notFound } from "../lib/errors.js";
import { afterCursor, newestFirst, page } from "../lib/pagination.js";
import { accountOf, principalOf, requireScope } from "../lib/principal.js";
import { authenticated, createRouter, errorResponses, jsonContent } from "../lib/router.js";
import { PageQuery, pageOf, toBase64, Uuid } from "../schemas.js";
import type { AppEnv, Services } from "../types.js";
import { createBlobReader } from "./gateway.js";
import {
  ObjectDetail,
  StoredObject,
  serializeBlob,
  serializeObject,
  storeOrder,
} from "./objects.js";

// What a grantee sees: the space or file shared with them, read through their grant. Every
// route checks the grant is active, unexpired and addressed to the caller (their account, or
// the agent their API key belongs to).

/** Objects a grantee can open: written and not deleted. */
const READABLE = ["uploading", "stored"] as const;

const GrantParam = z.object({
  grantId: Uuid.openapi({ param: { name: "grantId", in: "path" } }),
});

const SharedSpace = z
  .object({
    grantId: z.uuid(),
    spaceId: z.uuid(),
    objectId: z.uuid().nullable(),
    owner: z.string().openapi({ description: "The owner's AccountId32" }),
    encryptedName: z.string().openapi({ description: "Sealed with one of the space's key epochs" }),
    spaceKeyEpoch: z.number().int(),
    keyEpoch: z.number().int().nullable(),
    scope: z.enum(["read", "read_write"]),
    expiresAt: z.iso.datetime().nullable(),
  })
  .openapi("SharedSpace");

async function loadReceivedGrant(c: Context<AppEnv>, grantId: string) {
  const principal = principalOf(c);
  const accountId = accountOf(c);
  const [row] = await db
    .select({ grant: grants, space: spaces, owner: accounts.ownerAccount })
    .from(grants)
    .innerJoin(spaces, eq(spaces.id, grants.spaceId))
    .innerJoin(accounts, eq(accounts.id, spaces.accountId))
    .where(and(eq(grants.id, grantId), isNull(spaces.deletedAt)))
    .limit(1);
  if (!row) throw notFound("Grant");

  let addressedToCaller = false;
  if (row.grant.granteeKind === "account") {
    const [me] = await db
      .select({ owner: accounts.ownerAccount })
      .from(accounts)
      .where(eq(accounts.id, accountId));
    addressedToCaller = me?.owner === row.grant.grantee;
  } else if (principal.apiKey?.agentId) {
    const [agent] = await db
      .select({ key: agents.publicKey })
      .from(agents)
      .where(
        and(
          eq(agents.id, principal.apiKey.agentId),
          eq(agents.accountId, accountId),
          isNull(agents.revokedAt),
        ),
      );
    addressedToCaller = agent?.key === row.grant.grantee;
  }
  if (!addressedToCaller) throw notFound("Grant");

  if (row.grant.status === "revoked") {
    throw new HttpError(403, "GRANT_REVOKED", "The owner stopped sharing this with you.");
  }
  if (row.grant.expiresAt && row.grant.expiresAt <= new Date()) {
    throw new HttpError(403, "GRANT_EXPIRED", "This share has expired.");
  }
  if (row.grant.status !== "active" || !row.grant.wrappedKeyCid) {
    throw new HttpError(
      409,
      "GRANT_PENDING",
      "The owner's MemDot has not finished sharing this yet; it completes the next time they open MemDot.",
    );
  }
  return { ...row, wrappedKeyCid: row.grant.wrappedKeyCid };
}

/** What the grant covers: the whole space, or one file (and the tiny files packed in it). */
function coveredBy(grant: typeof grants.$inferSelect): SQL {
  const inSpace = and(eq(objects.spaceId, grant.spaceId), inArray(objects.status, [...READABLE]));
  if (!grant.objectId) return inSpace as SQL;
  return and(inSpace, eq(objects.id, grant.objectId)) as SQL;
}

export function sharedRoutes(services: Services) {
  const read = createBlobReader(services);
  return createRouter()
    .openapi(
      createRoute({
        method: "get",
        path: "/v1/shared/{grantId}",
        tags: ["Sharing"],
        summary: "What a grant shares with you",
        security: authenticated,
        middleware: [requireScope("files", "read")] as const,
        request: { params: GrantParam },
        responses: {
          200: { description: "Shared space", content: jsonContent(SharedSpace) },
          ...errorResponses,
        },
      }),
      async (c) => {
        const { grant, space, owner } = await loadReceivedGrant(c, c.req.valid("param").grantId);
        return c.json(
          {
            grantId: grant.id,
            spaceId: space.id,
            objectId: grant.objectId,
            owner,
            encryptedName: toBase64(space.encryptedName) ?? "",
            spaceKeyEpoch: space.keyEpoch,
            keyEpoch: grant.keyEpoch,
            scope: grant.scope,
            expiresAt: grant.expiresAt?.toISOString() ?? null,
          },
          200,
        );
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/v1/shared/{grantId}/key",
        tags: ["Sharing"],
        summary: "The key the owner wrapped for you",
        description:
          "A space keyring or a file manifest, sealed to your sharing key. Open it on your device.",
        security: authenticated,
        middleware: [requireScope("files", "read")] as const,
        request: { params: GrantParam },
        responses: {
          200: {
            description: "Sealed key",
            content: {
              "application/octet-stream": { schema: z.string().openapi({ format: "binary" }) },
            },
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        const { space, wrappedKeyCid } = await loadReceivedGrant(c, c.req.valid("param").grantId);
        // The owner vouches for this blob, so it can be served even before it is on chain.
        const { bytes } = await read(wrappedKeyCid, space.accountId);
        return c.body(bytes as Uint8Array<ArrayBuffer>, 200, {
          "content-type": "application/octet-stream",
          "cache-control": "private, no-store",
        });
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/v1/shared/{grantId}/objects",
        tags: ["Sharing"],
        summary: "Files a grant lets you open",
        security: authenticated,
        middleware: [requireScope("files", "read")] as const,
        request: {
          params: GrantParam,
          query: PageQuery.extend({ folderId: z.uuid().optional() }),
        },
        responses: {
          200: { description: "Objects", content: jsonContent(pageOf(StoredObject)) },
          ...errorResponses,
        },
      }),
      async (c) => {
        const { grant } = await loadReceivedGrant(c, c.req.valid("param").grantId);
        const query = c.req.valid("query");
        const rows = await db
          .select()
          .from(objects)
          .where(
            and(
              coveredBy(grant),
              query.folderId ? eq(objects.folderId, query.folderId) : undefined,
              afterCursor(query.cursor, objects.createdAt, objects.id),
            ),
          )
          .orderBy(...newestFirst(objects.createdAt, objects.id))
          .limit(query.limit + 1);
        const result = page(rows, query.limit);
        return c.json(
          { items: result.items.map(serializeObject), nextCursor: result.nextCursor },
          200,
        );
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/v1/shared/{grantId}/objects/{objectId}",
        tags: ["Sharing"],
        summary: "A shared file with its blobs",
        security: authenticated,
        middleware: [requireScope("files", "read")] as const,
        request: {
          params: GrantParam.extend({
            objectId: Uuid.openapi({ param: { name: "objectId", in: "path" } }),
          }),
        },
        responses: {
          200: { description: "Object", content: jsonContent(ObjectDetail) },
          ...errorResponses,
        },
      }),
      async (c) => {
        const params = c.req.valid("param");
        const { grant } = await loadReceivedGrant(c, params.grantId);
        const [object] = await db
          .select()
          .from(objects)
          .where(and(coveredBy(grant), eq(objects.id, params.objectId)))
          .limit(1);
        if (!object) throw notFound("Object");
        const items = await db
          .select()
          .from(storedItems)
          .where(eq(storedItems.objectId, object.id))
          .orderBy(asc(storedItems.role), asc(storedItems.chunkIndex));
        return c.json(
          {
            ...serializeObject(object),
            blobs: storeOrder(items).map((item) => serializeBlob(item, false)),
            headBlock: services.chainHead.block,
          },
          200,
        );
      },
    );
}
