import { createRoute, z } from "@hono/zod-openapi";
import { EVM_ACCOUNT_SUFFIX, SS58_PREFIX } from "@memdot/config";
import { accounts, agents, grants, objects, spaces } from "@memdot/db";
import { Address } from "@talismn/siws";
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  notInArray,
  or,
  type SQL,
} from "drizzle-orm";
import { db } from "../db.js";
import { badRequest, conflict, HttpError, notFound } from "../lib/errors.js";
import { tombstoneObjects } from "../lib/lifecycle.js";
import { loadObject, loadSpace } from "../lib/ownership.js";
import { accountOf, assertSpaceAllowed, principalOf, requireScope } from "../lib/principal.js";
import { revokeGrants } from "../lib/revoke.js";
import { authenticated, createRouter, errorResponses, jsonContent } from "../lib/router.js";
import { Cid, IdParam } from "../schemas.js";
import type { Principal } from "../types.js";

const Scope = z.enum(["read", "read_write"]);
const Status = z.enum(["pending", "active", "revoked", "expired"]);

const Grant = z
  .object({
    id: z.uuid(),
    spaceId: z.uuid(),
    objectId: z
      .uuid()
      .nullable()
      .openapi({ description: "Set for a file grant; null for the whole space" }),
    granteeKind: z.enum(["account", "agent"]),
    grantee: z
      .string()
      .openapi({ description: "AccountId32 hex for accounts, the age recipient for agents" }),
    scope: Scope,
    status: Status,
    wrappedKeyCid: z.string().nullable(),
    keyEpoch: z.number().int().nullable().openapi({
      description: "Space grants: the newest epoch the wrapped keyring holds",
    }),
    spaceKeyEpoch: z.number().int().openapi({ description: "The space's current key epoch" }),
    owner: z.string().nullable().openapi({ description: "The granting account's AccountId32" }),
    expiresAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    revokedAt: z.iso.datetime().nullable(),
  })
  .openapi("Grant");

const Recipient = z
  .object({
    accountId: z.string().openapi({ description: "AccountId32 hex" }),
    address: z.string().openapi({ description: "SS58 address" }),
    registered: z
      .boolean()
      .openapi({ description: "Has a MemDot sharing key; a share completes at once" }),
    encryptionKey: z.string().nullable(),
  })
  .openapi("Recipient");

const ReadyGrant = z
  .object({
    grant: Grant,
    reason: z.enum(["pending", "rotated"]).openapi({
      description:
        "pending: the recipient just set up MemDot. rotated: the space moved to a new key epoch after a revoke.",
    }),
    recipientKey: z.string().openapi({ description: "Seal the key or manifest to this" }),
  })
  .openapi("ReadyGrant");

/** SS58 (any prefix) or 0x AccountId32 → the account's id (lowercase hex) and SS58 form. */
const H160 = /^0x[0-9a-fA-F]{40}$/;

/** SS58, a 32-byte account id, or an EVM address (mapped the way Revive maps it). */
function parseAddress(address: string): { accountId: string; address: string } {
  const parsed = H160.test(address)
    ? Address.fromPubKey(`${address.toLowerCase()}${EVM_ACCOUNT_SUFFIX}`)
    : Address.fromSs58(address);
  if (!parsed || parsed.isEthereum) {
    throw badRequest(
      "ADDRESS",
      "Enter a Substrate address (SS58), an EVM address (0x…) or a 32-byte account id.",
    );
  }
  return { accountId: parsed.toPubKey().toLowerCase(), address: parsed.toSs58(SS58_PREFIX) };
}

async function recipientOf(input: string) {
  const { accountId, address } = parseAddress(input);
  const [row] = await db
    .select({ encryptionKey: accounts.encryptionKey })
    .from(accounts)
    .where(and(eq(accounts.ownerAccount, accountId), isNull(accounts.deletedAt)))
    .limit(1);
  return {
    accountId,
    address,
    registered: !!row?.encryptionKey,
    encryptionKey: row?.encryptionKey ?? null,
  };
}

type GrantRow = typeof grants.$inferSelect;
export const serializeGrant = (row: GrantRow, owner: string | null, spaceKeyEpoch: number) => ({
  id: row.id,
  spaceId: row.spaceId,
  objectId: row.objectId,
  granteeKind: row.granteeKind,
  grantee: row.grantee,
  scope: row.scope,
  status:
    row.expiresAt && row.expiresAt < new Date() && row.status !== "revoked"
      ? ("expired" as const)
      : row.status,
  wrappedKeyCid: row.wrappedKeyCid,
  keyEpoch: row.keyEpoch,
  spaceKeyEpoch,
  owner,
  expiresAt: row.expiresAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
  revokedAt: row.revokedAt?.toISOString() ?? null,
});

async function loadOwnGrant(principal: Principal, accountId: string, id: string) {
  const [row] = await db
    .select({ grant: grants, spaceKeyEpoch: spaces.keyEpoch, owner: accounts.ownerAccount })
    .from(grants)
    .innerJoin(spaces, eq(spaces.id, grants.spaceId))
    .innerJoin(accounts, eq(accounts.id, spaces.accountId))
    .where(and(eq(grants.id, id), eq(spaces.accountId, accountId)))
    .limit(1);
  if (!row) throw notFound("Grant");
  assertSpaceAllowed(principal, row.grant.spaceId);
  return row;
}

/** Space-scoped keys see only grants on their own spaces. */
function allowedSpaces(principal: Principal): SQL | undefined {
  const allowed = principal.apiKey?.spaceIds;
  return allowed ? inArray(grants.spaceId, allowed) : undefined;
}

async function ownerAccountOf(accountId: string): Promise<string | null> {
  const [me] = await db
    .select({ owner: accounts.ownerAccount })
    .from(accounts)
    .where(eq(accounts.id, accountId));
  return me?.owner ?? null;
}

/**
 * A wrapped key must be one of the owner's own grant-key objects, still live: a grant cannot
 * point at someone else's bytes or at a key that is no longer renewed.
 */
async function assertOwnGrantKey(accountId: string, cid: string): Promise<void> {
  const [key] = await db
    .select({ id: objects.id })
    .from(objects)
    .where(
      and(
        eq(objects.accountId, accountId),
        eq(objects.kind, "grant_key"),
        eq(objects.cid, cid),
        notInArray(objects.status, ["tombstoned", "failed"]),
      ),
    )
    .limit(1);
  if (!key) {
    throw badRequest("WRAPPED_KEY", "Store the wrapped key as a grant key object first.");
  }
}

/** A space grant's keyring must hold the space's current epoch, or new writes stay closed to it. */
function assertCurrentEpoch(
  objectId: string | null,
  keyEpoch: number | undefined,
  spaceEpoch: number,
) {
  if (objectId) return;
  if (keyEpoch !== spaceEpoch) {
    throw new HttpError(
      409,
      "KEY_EPOCH_STALE",
      "Wrap the space keyring through the current epoch.",
      { keyEpoch: spaceEpoch },
    );
  }
}

export function grantRoutes() {
  return createRouter()
    .openapi(
      createRoute({
        method: "get",
        path: "/v1/recipients/{address}",
        tags: ["Sharing"],
        summary: "Look up who you are sharing with",
        description:
          "Whether the address has a MemDot sharing key yet. Without one, a share waits as pending.",
        security: authenticated,
        middleware: [requireScope("grants", "read")] as const,
        request: {
          params: z.object({
            address: z.string().openapi({ param: { name: "address", in: "path" } }),
          }),
        },
        responses: {
          200: { description: "Recipient", content: jsonContent(Recipient) },
          ...errorResponses,
        },
      }),
      async (c) => c.json(await recipientOf(c.req.valid("param").address), 200),
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/v1/grants",
        tags: ["Sharing"],
        summary: "Grants you gave, or grants given to you",
        security: authenticated,
        middleware: [requireScope("grants", "read")] as const,
        request: {
          query: z.object({
            direction: z.enum(["given", "received"]).default("given"),
            spaceId: z.uuid().optional(),
            status: Status.optional(),
          }),
        },
        responses: {
          200: { description: "Grants", content: jsonContent(z.object({ items: z.array(Grant) })) },
          ...errorResponses,
        },
      }),
      async (c) => {
        const accountId = accountOf(c);
        const query = c.req.valid("query");
        let scope: SQL | undefined;
        if (query.direction === "given") {
          if (query.spaceId) await loadSpace(c, query.spaceId);
          scope = and(eq(spaces.accountId, accountId), allowedSpaces(principalOf(c)));
        } else {
          const owner = await ownerAccountOf(accountId);
          const myAgents = await db
            .select({ key: agents.publicKey })
            .from(agents)
            .where(and(eq(agents.accountId, accountId), isNull(agents.revokedAt)));
          scope = or(
            and(eq(grants.granteeKind, "account"), eq(grants.grantee, owner ?? "")),
            myAgents.length > 0
              ? and(
                  eq(grants.granteeKind, "agent"),
                  inArray(
                    grants.grantee,
                    myAgents.map((a) => a.key),
                  ),
                )
              : undefined,
          );
        }
        const rows = await db
          .select({ grant: grants, spaceKeyEpoch: spaces.keyEpoch, owner: accounts.ownerAccount })
          .from(grants)
          .innerJoin(spaces, eq(spaces.id, grants.spaceId))
          .innerJoin(accounts, eq(accounts.id, spaces.accountId))
          .where(
            and(
              scope,
              isNull(spaces.deletedAt),
              query.spaceId ? eq(grants.spaceId, query.spaceId) : undefined,
              query.status ? eq(grants.status, query.status) : undefined,
            ),
          )
          .orderBy(desc(grants.createdAt));
        return c.json(
          { items: rows.map((r) => serializeGrant(r.grant, r.owner, r.spaceKeyEpoch)) },
          200,
        );
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/v1/grants",
        tags: ["Sharing"],
        summary: "Share a space or a file",
        description:
          "Pass wrappedKeyCid when the recipient has a sharing key: for a space, a keyring sealed to them through the current epoch (keyEpoch); for a file, its manifest re-sealed to them. Both are stored first as grant key objects. Without a key the grant is pending until the recipient sets up MemDot and your client completes it.",
        security: authenticated,
        middleware: [requireScope("grants", "write")] as const,
        request: {
          body: {
            content: jsonContent(
              z
                .object({
                  spaceId: z.uuid(),
                  objectId: z.uuid().optional(),
                  grantee: z.discriminatedUnion("kind", [
                    z.object({ kind: z.literal("account"), address: z.string() }),
                    z.object({ kind: z.literal("agent"), agentId: z.uuid() }),
                  ]),
                  scope: Scope.default("read"),
                  expiresAt: z.iso.datetime().optional(),
                  wrappedKeyCid: Cid.optional(),
                  keyEpoch: z.number().int().min(0).optional(),
                })
                .openapi("NewGrant"),
            ),
            required: true,
          },
        },
        responses: {
          201: { description: "Created", content: jsonContent(Grant) },
          ...errorResponses,
        },
      }),
      async (c) => {
        const accountId = accountOf(c);
        const body = c.req.valid("json");
        const space = await loadSpace(c, body.spaceId);
        if (body.objectId) {
          const object = await loadObject(c, body.objectId);
          if (object.spaceId !== space.id) {
            throw badRequest("OBJECT_SPACE", "That object is in another space.");
          }
        }
        if (body.expiresAt && new Date(body.expiresAt) <= new Date()) {
          throw badRequest("EXPIRY", "The expiry must be in the future.");
        }
        if (body.wrappedKeyCid) {
          await assertOwnGrantKey(accountId, body.wrappedKeyCid);
          assertCurrentEpoch(body.objectId ?? null, body.keyEpoch, space.keyEpoch);
        }

        let grantee: string;
        if (body.grantee.kind === "account") {
          const recipient = await recipientOf(body.grantee.address);
          if (recipient.accountId === (await ownerAccountOf(accountId))) {
            throw badRequest("SELF", "You already own this space.");
          }
          if (body.wrappedKeyCid && !recipient.registered) {
            throw badRequest(
              "NO_RECIPIENT_KEY",
              "The recipient has no sharing key yet; create a pending grant instead.",
            );
          }
          grantee = recipient.accountId;
        } else {
          const [agent] = await db
            .select({ key: agents.publicKey })
            .from(agents)
            .where(
              and(
                eq(agents.id, body.grantee.agentId),
                eq(agents.accountId, accountId),
                isNull(agents.revokedAt),
              ),
            );
          if (!agent) throw badRequest("AGENT", "That agent does not exist or was revoked.");
          if (!body.wrappedKeyCid) {
            throw badRequest("WRAPPED_KEY", "Agent grants need the key wrapped to the agent.");
          }
          grantee = agent.key;
        }

        const [row] = await db
          .insert(grants)
          .values({
            spaceId: space.id,
            objectId: body.objectId ?? null,
            granteeKind: body.grantee.kind,
            grantee,
            scope: body.scope,
            status: body.wrappedKeyCid ? "active" : "pending",
            wrappedKeyCid: body.wrappedKeyCid ?? null,
            keyEpoch: body.wrappedKeyCid && !body.objectId ? space.keyEpoch : null,
            expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
          })
          .returning();
        if (!row) throw new Error("grant insert returned no row");
        return c.json(serializeGrant(row, await ownerAccountOf(accountId), space.keyEpoch), 201);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/v1/grants/ready",
        tags: ["Sharing"],
        summary: "Grants your client should wrap a key for now",
        description:
          "Called after unlocking. pending: the recipient has set up MemDot since you shared. rotated: a revoke moved the space to a new epoch, so a grant still active needs a keyring through it. Wrap, store the grant key, then complete each one (P5).",
        security: authenticated,
        middleware: [requireScope("grants", "write")] as const,
        responses: {
          200: {
            description: "To wrap",
            content: jsonContent(z.object({ items: z.array(ReadyGrant) })),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        const accountId = accountOf(c);
        const owner = await ownerAccountOf(accountId);
        const live = and(
          eq(spaces.accountId, accountId),
          allowedSpaces(principalOf(c)),
          isNull(spaces.deletedAt),
        );
        const pending = await db
          .select({
            grant: grants,
            spaceKeyEpoch: spaces.keyEpoch,
            recipientKey: accounts.encryptionKey,
          })
          .from(grants)
          .innerJoin(spaces, eq(spaces.id, grants.spaceId))
          .innerJoin(
            accounts,
            and(
              eq(accounts.ownerAccount, grants.grantee),
              isNull(accounts.deletedAt),
              isNotNull(accounts.encryptionKey),
            ),
          )
          .where(and(live, eq(grants.status, "pending"), eq(grants.granteeKind, "account")));
        const rotated = await db
          .select({ grant: grants, spaceKeyEpoch: spaces.keyEpoch })
          .from(grants)
          .innerJoin(spaces, eq(spaces.id, grants.spaceId))
          .where(
            and(
              live,
              eq(grants.status, "active"),
              isNull(grants.objectId),
              lt(grants.keyEpoch, spaces.keyEpoch),
            ),
          );
        // Agents are addressed by their own age recipient; accounts by their registered key.
        const rotatedKeys = new Map<string, string>();
        const accountGrantees = rotated
          .filter((r) => r.grant.granteeKind === "account")
          .map((r) => r.grant.grantee);
        if (accountGrantees.length > 0) {
          const keys = await db
            .select({ owner: accounts.ownerAccount, key: accounts.encryptionKey })
            .from(accounts)
            .where(
              and(inArray(accounts.ownerAccount, accountGrantees), isNull(accounts.deletedAt)),
            );
          for (const k of keys) if (k.key) rotatedKeys.set(k.owner, k.key);
        }
        const unexpired = (row: GrantRow) => !row.expiresAt || row.expiresAt > new Date();
        const items = [
          ...pending
            .filter((r) => unexpired(r.grant))
            .map((r) => ({
              grant: serializeGrant(r.grant, owner, r.spaceKeyEpoch),
              reason: "pending" as const,
              recipientKey: r.recipientKey ?? "",
            })),
          ...rotated
            .filter((r) => unexpired(r.grant))
            .flatMap((r) => {
              const recipientKey =
                r.grant.granteeKind === "agent"
                  ? r.grant.grantee
                  : rotatedKeys.get(r.grant.grantee);
              return recipientKey
                ? [
                    {
                      grant: serializeGrant(r.grant, owner, r.spaceKeyEpoch),
                      reason: "rotated" as const,
                      recipientKey,
                    },
                  ]
                : [];
            }),
        ];
        return c.json({ items }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/v1/grants/{id}/complete",
        tags: ["Sharing"],
        summary: "Give a grant its wrapped key (first time, or after a rotation)",
        description:
          "Activates a pending grant, or replaces an active space grant's keyring after the space moved to a new epoch. The previous grant key stops being renewed.",
        security: authenticated,
        middleware: [requireScope("grants", "write")] as const,
        request: {
          params: IdParam,
          body: {
            content: jsonContent(
              z.object({ wrappedKeyCid: Cid, keyEpoch: z.number().int().min(0).optional() }),
            ),
            required: true,
          },
        },
        responses: {
          200: { description: "Active", content: jsonContent(Grant) },
          ...errorResponses,
        },
      }),
      async (c) => {
        const accountId = accountOf(c);
        const body = c.req.valid("json");
        const { grant, owner, spaceKeyEpoch } = await loadOwnGrant(
          principalOf(c),
          accountId,
          c.req.valid("param").id,
        );
        if (grant.status !== "pending" && grant.status !== "active") {
          throw conflict("NOT_OPEN", `This grant is ${grant.status}.`);
        }
        await assertOwnGrantKey(accountId, body.wrappedKeyCid);
        assertCurrentEpoch(grant.objectId, body.keyEpoch, spaceKeyEpoch);
        const row = await db.transaction(async (tx) => {
          const [updated] = await tx
            .update(grants)
            .set({
              status: "active",
              wrappedKeyCid: body.wrappedKeyCid,
              keyEpoch: grant.objectId ? null : spaceKeyEpoch,
            })
            .where(and(eq(grants.id, grant.id), inArray(grants.status, ["pending", "active"])))
            .returning();
          if (!updated) throw conflict("NOT_OPEN", "This grant changed meanwhile; reload it.");
          if (grant.wrappedKeyCid && grant.wrappedKeyCid !== body.wrappedKeyCid) {
            await tombstoneObjects(
              tx,
              and(
                eq(objects.accountId, accountId),
                eq(objects.kind, "grant_key"),
                eq(objects.cid, grant.wrappedKeyCid),
              ) as SQL,
            );
          }
          return updated;
        });
        return c.json(serializeGrant(row, owner, spaceKeyEpoch), 200);
      },
    )
    .openapi(
      createRoute({
        method: "delete",
        path: "/v1/grants/{id}",
        tags: ["Sharing"],
        summary: "Revoke a grant",
        description:
          "Stops future access: the space moves to a new key epoch, so anything written from now on is sealed with a key the grantee never had, and its wrapped key stops being renewed. Anything already opened may have been kept.",
        security: authenticated,
        middleware: [requireScope("grants", "write")] as const,
        request: { params: IdParam },
        responses: {
          200: {
            description: "Revoked",
            content: jsonContent(
              z.object({ revoked: z.literal(true), spaceKeyEpoch: z.number().int() }),
            ),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        const { grant } = await loadOwnGrant(principalOf(c), accountOf(c), c.req.valid("param").id);
        await db.transaction((tx) => revokeGrants(tx, eq(grants.id, grant.id)));
        const [space] = await db
          .select({ keyEpoch: spaces.keyEpoch })
          .from(spaces)
          .where(eq(spaces.id, grant.spaceId));
        return c.json({ revoked: true as const, spaceKeyEpoch: space?.keyEpoch ?? 0 }, 200);
      },
    );
}
