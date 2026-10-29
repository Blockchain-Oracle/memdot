import { createRoute, z } from "@hono/zod-openapi";
import { accounts, account as authAccount, user as authUser, passkey } from "@memdot/db";
import { Address, verifySignature } from "@talismn/siws";
import { and, count, eq, isNull } from "drizzle-orm";
import { type Hex, verifyMessage } from "viem";
import { db } from "../db.js";
import { badRequest, conflict, forbidden } from "../lib/errors.js";
import { principalOf } from "../lib/principal.js";
import { authenticated, createRouter, errorResponses } from "../lib/router.js";
import { Cid, Hex32 } from "../schemas.js";

const RECOVERY_PROVIDER = "recovery-code";
/** Revive maps an unmapped H160 to an AccountId32 by appending twelve 0xEE bytes. */
const EVM_ACCOUNT_SUFFIX = "ee".repeat(12);

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
    keyBundleCid: Cid,
  })
  .openapi("AccountSetup");

type AccountRow = typeof accounts.$inferSelect;
const serialize = (row: AccountRow) => ({
  id: row.id,
  ownerAccount: row.ownerAccount,
  evmAddress: row.evmAddress,
  encryptionKey: row.encryptionKey,
  keyBundleCid: row.keyBundleCid,
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

export function accountRoutes() {
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
        summary: "Finish setup: chain owner, sharing key and key bundle",
        description:
          "Called by the client after it creates the master key, stores the key bundle and registers the recovery code. Dashboard sessions only.",
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

        const values = {
          ownerAccount: owner.ownerAccount,
          evmAddress: owner.evmAddress,
          encryptionKey: body.encryptionKey,
          keyBundleCid: body.keyBundleCid,
        };
        const [row] = await db
          .insert(accounts)
          .values({ userId: principal.userId, ...values })
          .onConflictDoUpdate({ target: accounts.userId, set: values })
          .returning();
        if (!row) throw new Error("account upsert returned no row");
        return c.json(serialize(row), 200);
      },
    );
}
