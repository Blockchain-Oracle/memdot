import { createRoute, z } from "@hono/zod-openapi";
import { SS58_PREFIX } from "@memdot/config";
import { accounts, agents, grants, spaces } from "@memdot/db";
import { Address } from "@talismn/siws";
import { and, desc, eq, inArray, isNotNull, isNull, or, type SQL } from "drizzle-orm";
import { db } from "../db.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { loadObject, loadSpace } from "../lib/ownership.js";
import { accountOf, requireScope } from "../lib/principal.js";
import { revokeGrants } from "../lib/revoke.js";
import { authenticated, createRouter, errorResponses, jsonContent } from "../lib/router.js";
import { Cid, IdParam } from "../schemas.js";

const Scope = z.enum(["read", "read_write"]);
const Status = z.enum(["pending", "active", "revoked", "expired"]);

const Grant = z
  .object({
    id: z.uuid(),
    spaceId: z.uuid(),
    objectId: z.uuid().nullable(),
    granteeKind: z.enum(["account", "agent"]),
    grantee: z
      .string()
      .openapi({ description: "AccountId32 hex for accounts, the age recipient for agents" }),
    scope: Scope,
    status: Status,
    wrappedKeyCid: z.string().nullable(),
    owner: z.string().nullable().openapi({ description: "The granting account's AccountId32" }),
    keyEpoch: z.number().int(),
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

/** SS58 (any prefix) or 0x AccountId32 → the account's id (lowercase hex) and SS58 form. */
function parseAddress(address: string): { accountId: string; address: string } {
  const parsed = Address.fromSs58(address);
  if (!parsed || parsed.isEthereum) {
    throw badRequest("ADDRESS", "Enter a Substrate address (SS58) or a 32-byte account id.");
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
const serialize = (row: GrantRow, owner: string | null, keyEpoch: number) => ({
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
  owner,
  keyEpoch,
  expiresAt: row.expiresAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
  revokedAt: row.revokedAt?.toISOString() ?? null,
});

async function loadOwnGrant(accountId: string, id: string) {
  const [row] = await db
    .select({ grant: grants, keyEpoch: spaces.keyEpoch, owner: accounts.ownerAccount })
    .from(grants)
    .innerJoin(spaces, eq(spaces.id, grants.spaceId))
    .innerJoin(accounts, eq(accounts.id, spaces.accountId))
    .where(and(eq(grants.id, id), eq(spaces.accountId, accountId)))
    .limit(1);
  if (!row) throw notFound("Grant");
  return row;
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
        if (query.spaceId) await loadSpace(c, query.spaceId);
        let scope: SQL | undefined;
        if (query.direction === "given") {
          scope = eq(spaces.accountId, accountId);
        } else {
          const [me] = await db
            .select({ owner: accounts.ownerAccount })
            .from(accounts)
            .where(eq(accounts.id, accountId));
          const myAgents = await db
            .select({ key: agents.publicKey })
            .from(agents)
            .where(and(eq(agents.accountId, accountId), isNull(agents.revokedAt)));
          scope = or(
            and(eq(grants.granteeKind, "account"), eq(grants.grantee, me?.owner ?? "")),
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
          .select({ grant: grants, keyEpoch: spaces.keyEpoch, owner: accounts.ownerAccount })
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
        return c.json({ items: rows.map((r) => serialize(r.grant, r.owner, r.keyEpoch)) }, 200);
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/v1/grants",
        tags: ["Sharing"],
        summary: "Share a space, folder or file",
        description:
          "Pass wrappedKeyCid when the recipient has a sharing key (the client stored the key wrapped to them). Without it the grant is pending until the recipient sets up MemDot and your client completes it.",
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
          if (object.spaceId !== space.id)
            throw badRequest("OBJECT_SPACE", "That object is in another space.");
        }
        if (body.expiresAt && new Date(body.expiresAt) <= new Date()) {
          throw badRequest("EXPIRY", "The expiry must be in the future.");
        }

        let grantee: string;
        if (body.grantee.kind === "account") {
          const recipient = await recipientOf(body.grantee.address);
          const [me] = await db
            .select({ owner: accounts.ownerAccount })
            .from(accounts)
            .where(eq(accounts.id, accountId));
          if (recipient.accountId === me?.owner)
            throw badRequest("SELF", "You already own this space.");
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
          if (!body.wrappedKeyCid)
            throw badRequest("WRAPPED_KEY", "Agent grants need the key wrapped to the agent.");
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
            expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
          })
          .returning();
        if (!row) throw new Error("grant insert returned no row");
        const [me] = await db
          .select({ owner: accounts.ownerAccount })
          .from(accounts)
          .where(eq(accounts.id, accountId));
        return c.json(serialize(row, me?.owner ?? null, space.keyEpoch), 201);
      },
    )
    .openapi(
      createRoute({
        method: "get",
        path: "/v1/grants/ready",
        tags: ["Sharing"],
        summary: "Pending grants whose recipient can now receive the key",
        description:
          "Your client calls this after unlocking, wraps the key to each recipient and completes the grant (P5).",
        security: authenticated,
        middleware: [requireScope("grants", "write")] as const,
        responses: {
          200: {
            description: "Ready to complete",
            content: jsonContent(
              z.object({ items: z.array(z.object({ grant: Grant, recipientKey: z.string() })) }),
            ),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        const accountId = accountOf(c);
        const rows = await db
          .select({
            grant: grants,
            keyEpoch: spaces.keyEpoch,
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
          .where(
            and(
              eq(spaces.accountId, accountId),
              eq(grants.status, "pending"),
              eq(grants.granteeKind, "account"),
              isNull(spaces.deletedAt),
            ),
          );
        const [me] = await db
          .select({ owner: accounts.ownerAccount })
          .from(accounts)
          .where(eq(accounts.id, accountId));
        return c.json(
          {
            items: rows
              .filter((r) => !r.grant.expiresAt || r.grant.expiresAt > new Date())
              .map((r) => ({
                grant: serialize(r.grant, me?.owner ?? null, r.keyEpoch),
                recipientKey: r.recipientKey ?? "",
              })),
          },
          200,
        );
      },
    )
    .openapi(
      createRoute({
        method: "post",
        path: "/v1/grants/{id}/complete",
        tags: ["Sharing"],
        summary: "Complete a pending grant with the wrapped key",
        security: authenticated,
        middleware: [requireScope("grants", "write")] as const,
        request: {
          params: IdParam,
          body: { content: jsonContent(z.object({ wrappedKeyCid: Cid })), required: true },
        },
        responses: {
          200: { description: "Active", content: jsonContent(Grant) },
          ...errorResponses,
        },
      }),
      async (c) => {
        const { grant, owner, keyEpoch } = await loadOwnGrant(
          accountOf(c),
          c.req.valid("param").id,
        );
        if (grant.status !== "pending")
          throw conflict("NOT_PENDING", `This grant is ${grant.status}.`);
        const [row] = await db
          .update(grants)
          .set({ status: "active", wrappedKeyCid: c.req.valid("json").wrappedKeyCid })
          .where(and(eq(grants.id, grant.id), eq(grants.status, "pending")))
          .returning();
        if (!row) throw conflict("NOT_PENDING", "This grant changed meanwhile; reload it.");
        return c.json(serialize(row, owner, keyEpoch), 200);
      },
    )
    .openapi(
      createRoute({
        method: "delete",
        path: "/v1/grants/{id}",
        tags: ["Sharing"],
        summary: "Revoke a grant",
        description:
          "Stops future access: the space moves to a new key epoch and your client rotates the key. Anything already opened may have been kept.",
        security: authenticated,
        middleware: [requireScope("grants", "write")] as const,
        request: { params: IdParam },
        responses: {
          200: {
            description: "Revoked",
            content: jsonContent(
              z.object({ revoked: z.literal(true), keyEpoch: z.number().int() }),
            ),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        const { grant } = await loadOwnGrant(accountOf(c), c.req.valid("param").id);
        await db.transaction((tx) => revokeGrants(tx, eq(grants.id, grant.id)));
        const [space] = await db
          .select({ keyEpoch: spaces.keyEpoch })
          .from(spaces)
          .where(eq(spaces.id, grant.spaceId));
        return c.json({ revoked: true as const, keyEpoch: space?.keyEpoch ?? 0 }, 200);
      },
    );
}
