import { verifyRecoveryChallenge } from "@memdot/crypto";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, freshSessionMiddleware } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { generateRandomString } from "better-auth/crypto";
import * as z from "zod";

/**
 * Sign-in with the 12-word recovery code alone, for a new browser with no passkey or wallet.
 * The client derives an ed25519 key from the code (`recoverySignInKey`) and registers only its
 * public key, stored as an account row (`providerId: "recovery-code"`). Sign-in signs a
 * one-use server challenge. The same code still has to open the key bundle, so this grants a
 * session, never the data.
 */
const PROVIDER_ID = "recovery-code";
const CHALLENGE_LABEL = "memdot:recovery-sign-in:v1:";
const CHALLENGE_PREFIX = "recovery:";
const NONCE_LENGTH = 32;
const CHALLENGE_TTL_MS = 5 * 60_000;

const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const hex64 = z.string().regex(/^0x[0-9a-fA-F]{128}$/);

/** One message for every failure, so the endpoint does not reveal which codes exist. */
const notRecognised = () =>
  APIError.fromStatus("UNAUTHORIZED", {
    message: "That recovery code was not recognised.",
    code: "RECOVERY_CODE_INVALID",
  });

const toHex = (bytes: Uint8Array) => `0x${bytesToHex(bytes)}`;
const fromHex = (hex: string) => hexToBytes(hex.slice(2));

export const recoveryCode = () =>
  ({
    id: "recovery-code",
    endpoints: {
      /** Sets (or replaces) the account's recovery key. Replacing it retires the old code. */
      registerRecoveryKey: createAuthEndpoint(
        "/recovery/register",
        { method: "POST", body: z.object({ publicKey: hex32 }), use: [freshSessionMiddleware] },
        async (ctx) => {
          const userId = ctx.context.session.user.id;
          const accountId = toHex(fromHex(ctx.body.publicKey));
          const adapter = ctx.context.internalAdapter;

          const existing = await adapter.findAccountByKey({ providerId: PROVIDER_ID, accountId });
          if (existing && existing.userId !== userId) {
            throw APIError.fromStatus("CONFLICT", { message: "Generate a new recovery code." });
          }
          if (existing) return ctx.json({ registered: true });

          const previous = (await adapter.findAccounts(userId)).filter(
            (account) => account.providerId === PROVIDER_ID,
          );
          await adapter.linkAccount({ userId, providerId: PROVIDER_ID, accountId });
          for (const account of previous) await adapter.deleteAccount(account.id);
          return ctx.json({ registered: true });
        },
      ),

      /** Issues a one-use challenge for the recovery key to sign. */
      recoveryChallenge: createAuthEndpoint(
        "/recovery/challenge",
        { method: "POST" },
        async (ctx) => {
          const nonce = generateRandomString(NONCE_LENGTH, "a-z", "A-Z", "0-9");
          await ctx.context.internalAdapter.createVerificationValue({
            identifier: `${CHALLENGE_PREFIX}${nonce}`,
            value: nonce,
            expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
          });
          return ctx.json({ challenge: `${CHALLENGE_LABEL}${nonce}` });
        },
      ),

      /** Verifies the signed challenge and starts a session for the account that owns the key. */
      verifyRecovery: createAuthEndpoint(
        "/recovery/verify",
        {
          method: "POST",
          body: z.object({ publicKey: hex32, challenge: z.string().max(128), signature: hex64 }),
          requireRequest: true,
        },
        async (ctx) => {
          const { publicKey, challenge, signature } = ctx.body;
          if (!challenge.startsWith(CHALLENGE_LABEL)) throw notRecognised();
          const nonce = challenge.slice(CHALLENGE_LABEL.length);

          const consumed = await ctx.context.internalAdapter.consumeVerificationValue(
            `${CHALLENGE_PREFIX}${nonce}`,
          );
          if (!consumed) throw notRecognised();

          const key = fromHex(publicKey);
          if (!verifyRecoveryChallenge(key, utf8ToBytes(challenge), fromHex(signature))) {
            throw notRecognised();
          }

          const owner = await ctx.context.internalAdapter.findAccountOwnerByKey({
            providerId: PROVIDER_ID,
            accountId: toHex(key),
          });
          if (owner?.kind !== "owned") throw notRecognised();

          const session = await ctx.context.internalAdapter.createSession(owner.user.id);
          if (!session) {
            throw APIError.fromStatus("INTERNAL_SERVER_ERROR", {
              message: "Could not start a session.",
            });
          }
          await setSessionCookie(ctx, { session, user: owner.user });
          return ctx.json({ token: session.token, user: { id: owner.user.id } });
        },
      ),
    },
    rateLimit: [{ pathMatcher: (path) => path.startsWith("/recovery/"), window: 60, max: 10 }],
  }) satisfies BetterAuthPlugin;
