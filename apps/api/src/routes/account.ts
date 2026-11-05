import { createRoute, z } from "@hono/zod-openapi";
import { EVM_ACCOUNT_SUFFIX } from "@memdot/config";
import { Action, NO_SALT } from "@memdot/contracts";
import {
  accounts,
  agents,
  apikey,
  account as authAccount,
  user as authUser,
  folders,
  grants,
  jobs,
  memoryConfig,
  memoryInbox,
  memoryProfiles,
  memorySettings,
  oauthAccessToken,
  oauthConsent,
  oauthRefreshToken,
  objects,
  passkey,
  session,
  spaces,
  walletAddress,
  webhooks,
} from "@memdot/db";
import { enqueueChainTx, updateJob } from "@memdot/jobs";
import { Address, verifySignature } from "@talismn/siws";
import { and, count, eq, inArray, isNull, ne, notInArray, type SQL } from "drizzle-orm";
import { type Hex, verifyMessage } from "viem";
import { isFresh } from "../auth/index.js";
import { db } from "../db.js";
import { badRequest, conflict, forbidden } from "../lib/errors.js";
import { tombstoneObjects } from "../lib/lifecycle.js";
import {
  accountOf,
  assertFreshSession,
  forgetAccount,
  forgetApiKeys,
  principalOf,
} from "../lib/principal.js";
import { authenticated, createRouter, errorResponses, jsonContent } from "../lib/router.js";
import { Cid, Hex32 } from "../schemas.js";
import type { Services } from "../types.js";
import { decodeRecordCall, MAX_CALLDATA_HEX_CHARS } from "./registry.js";

const RECOVERY_PROVIDER = "recovery-code";
/** What the owner signs to prove the chain account is theirs (it is bound to the user id). */
export const ownerProofMessage = (userId: string, ownerAccount: string) =>
  `memdot:owner:v1:${userId}:${ownerAccount}`;

const Account = z
  .object({
    id: z.uuid(),
    ownerAccount: z
      .string()
      .openapi({ description: "AccountId32 (0x-hex) that owns registry records" }),
    evmAddress: z.string().nullable(),
    encryptionKey: z
      .string()
      .nullable()
      .openapi({ description: "X25519 sharing key (age recipient)" }),
    keyBundleCid: z.string().nullable(),
    registryOwner: z
      .string()
      .nullable()
      .openapi({ description: "The key that signs this account's MemDotRegistry records" }),
    createdAt: z.iso.datetime(),
  })
  .openapi("Account");

const Me = z
  .object({
    user: z.object({ id: z.string(), name: z.string(), image: z.string().nullable() }),
    account: Account.nullable().openapi({ description: "Null until setup is finished" }),
    signIn: z.object({
      passkeys: z.number().int(),
      wallets: z.array(z.object({ kind: z.enum(["substrate", "evm"]), id: z.string() })),
      recoveryCode: z.boolean(),
      /** Recent enough for a change that outlives this session. */
      fresh: z.boolean(),
    }),
  })
  .openapi("Me");

const Setup = z
  .object({
    owner: z.discriminatedUnion("kind", [
      z.object({
        kind: z.literal("substrate"),
        account: Hex32,
        /** sr25519/ed25519 signature over ownerProofMessage (wallet `<Bytes>` wrapping accepted). */
        signature: z.string().regex(/^0x[0-9a-fA-F]{128,132}$/),
      }),
      z.object({
        kind: z.literal("evm"),
        address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
        /** EIP-191 personal_sign over ownerProofMessage. */
        signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
      }),
    ]),
    encryptionKey: z.string().regex(/^age1[0-9a-z]{58}$/, "Expected an age X25519 recipient."),
    /** Set on the second call, once the key bundle is stored as an account object. */
    keyBundleCid: Cid.optional(),
  })
  .openapi("AccountSetup");

type AccountRow = typeof accounts.$inferSelect;
const serialize = (row: AccountRow) => ({
  id: row.id,
  ownerAccount: row.ownerAccount,
  evmAddress: row.evmAddress,
  encryptionKey: row.encryptionKey,
  keyBundleCid: row.keyBundleCid,
  registryOwner: row.registryOwner,
  createdAt: row.createdAt.toISOString(),
});

async function verifyOwner(
  userId: string,
  owner: z.infer<typeof Setup>["owner"],
): Promise<{ ownerAccount: string; evmAddress: string | null }> {
  if (owner.kind === "substrate") {
    const message = ownerProofMessage(userId, owner.account);
    const key = Address.fromPubKey(owner.account);
    if (!key || !verifySignature(message, owner.signature, key.bytes).isValid) {
      throw badRequest("OWNER_PROOF", "The chain account's signature does not match.");
    }
    return { ownerAccount: owner.account, evmAddress: null };
  }
  const address = owner.address.toLowerCase();
  const ownerAccount = `${address}${EVM_ACCOUNT_SUFFIX}`;
  const valid = await verifyMessage({
    address: address as Hex,
    message: ownerProofMessage(userId, ownerAccount),
    signature: owner.signature as Hex,
  }).catch(() => false);
  if (!valid) throw badRequest("OWNER_PROOF", "The wallet's signature does not match.");
  return { ownerAccount, evmAddress: address };
}

export function accountRoutes(services: Services) {
  return createRouter()
    .openapi(
      createRoute({
        method: "get",
        path: "/v1/account",
        tags: ["Account"],
        summary: "The signed-in user, their MemDot account and sign-in methods",
        security: authenticated,
        responses: {
          200: { description: "Me", content: { "application/json": { schema: Me } } },
          ...errorResponses,
        },
      }),
      async (c) => {
        const principal = principalOf(c);
        // A connected agent acts for its owner, and doesn't need to know their wallets or passkeys.
        if (principal.apiKey?.agentId) {
          return c.json(
            {
              user: { id: principal.userId, name: "", image: null },
              account: null,
              signIn: { fresh: false, passkeys: 0, wallets: [], recoveryCode: false },
            },
            200,
          );
        }
        const [user] = await db
          .select({ name: authUser.name, image: authUser.image })
          .from(authUser)
          .where(eq(authUser.id, principal.userId))
          .limit(1);
        const [row] = principal.accountId
          ? await db.select().from(accounts).where(eq(accounts.id, principal.accountId))
          : [];
        const linked = await db
          .select({ providerId: authAccount.providerId, accountId: authAccount.accountId })
          .from(authAccount)
          .where(eq(authAccount.userId, principal.userId));
        const [passkeys] = await db
          .select({ n: count() })
          .from(passkey)
          .where(eq(passkey.userId, principal.userId));
        return c.json(
          {
            user: { id: principal.userId, name: user?.name ?? "", image: user?.image ?? null },
            account: row ? serialize(row) : null,
            signIn: {
              fresh:
                principal.via === "session" &&
                principal.sessionCreatedAt !== null &&
                isFresh(principal.sessionCreatedAt),
              passkeys: passkeys?.n ?? 0,
              wallets: linked
                .filter((a) => a.providerId === "siws" || a.providerId === "siwe")
                .map((a) => ({
                  kind: a.providerId === "siws" ? ("substrate" as const) : ("evm" as const),
                  id: a.accountId,
                })),
              recoveryCode: linked.some((a) => a.providerId === RECOVERY_PROVIDER),
            },
          },
          200,
        );
      },
    )
    .openapi(
      createRoute({
        method: "put",
        path: "/v1/account",
        tags: ["Account"],
        summary: "Set up the account: chain owner, sharing key, then key bundle",
        description:
          "Two calls. First, after the client creates the master key and registers the recovery code: the owner proof and sharing key create the account. Then, once the key bundle is stored (POST /v1/objects, kind key_bundle), the same call with keyBundleCid points the account at it. Dashboard sessions only.",
        security: [{ Session: [] }],
        request: { body: { content: { "application/json": { schema: Setup } }, required: true } },
        responses: {
          200: { description: "Account", content: { "application/json": { schema: Account } } },
          ...errorResponses,
        },
      }),
      async (c) => {
        const principal = principalOf(c);
        if (principal.via !== "session") {
          throw forbidden("Account setup happens in the dashboard, not with an API key.");
        }
        // Replacing the sharing key or owner on an existing account redirects future shares, so it
        // needs a recent sign-in; first-time setup happens right after sign-up anyway.
        if (principal.accountId) assertFreshSession(principal);
        const body = c.req.valid("json");
        const [recovery] = await db
          .select({ id: authAccount.id })
          .from(authAccount)
          .where(
            and(
              eq(authAccount.userId, principal.userId),
              eq(authAccount.providerId, RECOVERY_PROVIDER),
            ),
          )
          .limit(1);
        if (!recovery) {
          throw conflict("RECOVERY_CODE_REQUIRED", "Save a recovery code before finishing setup.");
        }
        const owner = await verifyOwner(principal.userId, body.owner);

        const [taken] = await db
          .select({ userId: accounts.userId })
          .from(accounts)
          .where(and(eq(accounts.ownerAccount, owner.ownerAccount), isNull(accounts.deletedAt)))
          .limit(1);
        if (taken && taken.userId !== principal.userId) {
          throw conflict("OWNER_TAKEN", "That chain account already owns another MemDot account.");
        }

        if (body.keyBundleCid) {
          const [bundle] = principal.accountId
            ? await db
                .select({ id: objects.id })
                .from(objects)
                .where(
                  and(
                    eq(objects.accountId, principal.accountId),
                    eq(objects.kind, "key_bundle"),
                    eq(objects.cid, body.keyBundleCid),
                    ne(objects.status, "tombstoned"),
                  ),
                )
                .limit(1)
            : [];
          if (!bundle) {
            throw badRequest(
              "KEY_BUNDLE_UNKNOWN",
              "Store the key bundle on this account before pointing to it.",
            );
          }
        }

        const values = {
          ownerAccount: owner.ownerAccount,
          evmAddress: owner.evmAddress,
          encryptionKey: body.encryptionKey,
          ...(body.keyBundleCid ? { keyBundleCid: body.keyBundleCid } : {}),
        };
        const [row] = await db
          .insert(accounts)
          .values({ userId: principal.userId, ...values })
          .onConflictDoUpdate({ target: accounts.userId, set: values })
          .returning();
        if (!row) throw new Error("account upsert returned no row");
        forgetAccount(principal.userId);
        return c.json(serialize(row), 200);
      },
    )
    .openapi(
      createRoute({
        method: "patch",
        path: "/v1/account",
        tags: ["Account"],
        summary: "Point the account at a new key bundle",
        description:
          "After the client re-wraps the master key (a new recovery code, an added passkey or wallet) and stores the new bundle. Needs a recent sign-in in the dashboard.",
        security: [{ Session: [] }],
        request: {
          body: {
            content: jsonContent(z.object({ keyBundleCid: Cid }).openapi("KeyBundleUpdate")),
            required: true,
          },
        },
        responses: {
          200: { description: "Account", content: jsonContent(Account) },
          ...errorResponses,
        },
      }),
      async (c) => {
        const principal = principalOf(c);
        if (principal.via !== "session") {
          throw forbidden("Unlock methods change in the dashboard, not with an API key.");
        }
        assertFreshSession(principal);
        const accountId = accountOf(c);
        const { keyBundleCid } = c.req.valid("json");
        const [bundle] = await db
          .select({ id: objects.id })
          .from(objects)
          .where(
            and(
              eq(objects.accountId, accountId),
              eq(objects.kind, "key_bundle"),
              eq(objects.cid, keyBundleCid),
              ne(objects.status, "tombstoned"),
            ),
          )
          .limit(1);
        if (!bundle) {
          throw badRequest(
            "KEY_BUNDLE_UNKNOWN",
            "Store the key bundle on this account before pointing to it.",
          );
        }
        const [previous] = await db
          .select({ keyBundleCid: accounts.keyBundleCid })
          .from(accounts)
          .where(eq(accounts.id, accountId));
        const row = await db.transaction(async (tx) => {
          const [updated] = await tx
            .update(accounts)
            .set({ keyBundleCid })
            .where(eq(accounts.id, accountId))
            .returning();
          // The old bundle still opens with the old recovery code: stop renewing it.
          if (previous?.keyBundleCid && previous.keyBundleCid !== keyBundleCid) {
            await tombstoneObjects(
              tx,
              and(
                eq(objects.accountId, accountId),
                eq(objects.kind, "key_bundle"),
                eq(objects.cid, previous.keyBundleCid),
              ) as SQL,
            );
          }
          return updated;
        });
        if (!row) throw new Error("account update returned no row");
        return c.json(serialize(row), 200);
      },
    )
    .openapi(
      createRoute({
        method: "delete",
        path: "/v1/account",
        tags: ["Account"],
        summary: "Delete this account",
        description:
          "Stops every renewal, forgets all memories, revokes keys, agents and grants, and removes every way to sign in. Stored bytes expire from the chain within 7 days, and what was already shared or downloaded can't be recalled. Dashboard only, after a recent sign-in.",
        security: [{ Session: [] }],
        request: {
          body: {
            required: false,
            content: jsonContent(
              z.object({
                record: z
                  .string()
                  .max(MAX_CALLDATA_HEX_CHARS)
                  .regex(/^0x[0-9a-fA-F]+$/)
                  .optional()
                  .openapi({
                    description: "The owner-signed registry record saying this account has left",
                  }),
              }),
            ),
          },
        },
        responses: {
          200: {
            description: "Deleted",
            content: jsonContent(
              z
                .object({ deleted: z.literal(true), objects: z.number().int() })
                .openapi("AccountDeleted"),
            ),
          },
          ...errorResponses,
        },
      }),
      async (c) => {
        const principal = principalOf(c);
        if (principal.via !== "session") {
          throw forbidden("An account can only be deleted from the dashboard.");
        }
        assertFreshSession(principal);
        const accountId = accountOf(c);
        const closing = c.req.valid("json")?.record as Hex | undefined;
        const [current] = await db.select().from(accounts).where(eq(accounts.id, accountId));
        if (closing) {
          const [owner, salt, action] = decodeRecordCall(closing);
          if (
            salt !== NO_SALT ||
            action !== Action.DeleteAccount ||
            !current?.registryOwner ||
            current.registryOwner !== owner
          ) {
            throw badRequest("BAD_RECORD", "That isn't this account's closing record.");
          }
        }
        const objectCount = await db.transaction(async (tx) => {
          const now = new Date();
          const tombstoned = await tombstoneObjects(tx, eq(objects.accountId, accountId) as SQL);
          // Writes still queued must not run, or use a model, for an account that's gone.
          const queued = await tx
            .select({ id: jobs.id })
            .from(jobs)
            .where(
              and(eq(jobs.accountId, accountId), notInArray(jobs.status, ["finalized", "failed"])),
            );
          for (const job of queued) {
            await updateJob(tx, job.id, { status: "failed", error: "The account was deleted." });
          }
          if (queued.length > 0) {
            await tx.delete(memoryInbox).where(
              inArray(
                memoryInbox.jobId,
                queued.map((job) => job.id),
              ),
            );
          }
          const owned = tx
            .select({ id: spaces.id })
            .from(spaces)
            .where(eq(spaces.accountId, accountId));
          await tx
            .update(grants)
            .set({ status: "revoked", revokedAt: now })
            .where(inArray(grants.spaceId, owned));
          await tx.update(folders).set({ deletedAt: now }).where(inArray(folders.spaceId, owned));
          await tx
            .update(spaces)
            .set({ deletedAt: now, usedBytes: 0 })
            .where(eq(spaces.accountId, accountId));
          await tx
            .update(agents)
            .set({ revokedAt: now, namespaces: null })
            .where(eq(agents.accountId, accountId));
          await tx.delete(memoryConfig).where(eq(memoryConfig.accountId, accountId));
          await tx.delete(webhooks).where(eq(webhooks.accountId, accountId));
          await tx
            .delete(memoryProfiles)
            .where(
              inArray(
                memoryProfiles.folderId,
                tx.select({ id: folders.id }).from(folders).where(inArray(folders.spaceId, owned)),
              ),
            );
          await tx
            .delete(memorySettings)
            .where(
              inArray(
                memorySettings.folderId,
                tx.select({ id: folders.id }).from(folders).where(inArray(folders.spaceId, owned)),
              ),
            );
          if (closing)
            await enqueueChainTx(services.boss, tx, { action: "registry", calldata: closing });
          // The chain owner and sharing key go free, so the same wallet can start again.
          await tx
            .update(accounts)
            .set({
              deletedAt: now,
              ownerAccount: `deleted:${accountId}`,
              evmAddress: null,
              encryptionKey: null,
              keyBundleCid: null,
              registryOwner: null,
            })
            .where(eq(accounts.id, accountId));
          await tx.delete(apikey).where(eq(apikey.referenceId, principal.userId));
          await tx.delete(oauthAccessToken).where(eq(oauthAccessToken.userId, principal.userId));
          await tx.delete(oauthRefreshToken).where(eq(oauthRefreshToken.userId, principal.userId));
          await tx.delete(oauthConsent).where(eq(oauthConsent.userId, principal.userId));
          await tx.delete(passkey).where(eq(passkey.userId, principal.userId));
          await tx.delete(authAccount).where(eq(authAccount.userId, principal.userId));
          await tx.delete(walletAddress).where(eq(walletAddress.userId, principal.userId));
          await tx.delete(session).where(eq(session.userId, principal.userId));
          // The row stays for the account's foreign key; nothing in it identifies anyone now.
          await tx
            .update(authUser)
            .set({
              name: "Deleted account",
              email: `deleted-${principal.userId}@memdot.invalid`,
              image: null,
            })
            .where(eq(authUser.id, principal.userId));
          return tombstoned;
        });
        forgetAccount(principal.userId);
        forgetApiKeys();
        return c.json({ deleted: true as const, objects: objectCount }, 200);
      },
    );
}
