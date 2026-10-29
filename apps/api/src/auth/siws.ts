import { SS58_PREFIX } from "@memdot/config";
import { Address, parseMessage, type SiwsMessage, verifySignature } from "@talismn/siws";
import type { BetterAuthPlugin, User } from "better-auth";
import { APIError, createAuthEndpoint, getSessionFromCtx } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { generateRandomString } from "better-auth/crypto";
import * as z from "zod";
import { placeholderEmail } from "./placeholder.js";

/**
 * Sign-In with Substrate for Talisman, SubWallet and polkadot.js. The wallet signs a SIWS
 * message (wallets wrap it in `<Bytes>`; the verifier accepts both forms). A verified address
 * becomes a Better Auth account row (`providerId: "siws"`, `accountId`: AccountId32 hex), so a
 * wallet can create a MemDot account, sign in to one, or be linked to the signed-in one.
 */
export interface SiwsOptions {
  /** The dashboard origin; the message's domain and URI must name it. */
  origin: string;
}

const PROVIDER_ID = "siws";
const NONCE_PREFIX = "siws:";
const NONCE_LENGTH = 32;
const NONCE_TTL_MS = 10 * 60_000;
/** A signed message older than this is refused even when its nonce is still unused. */
const MAX_MESSAGE_AGE_MS = 10 * 60_000;
const CLOCK_SKEW_MS = 60_000;

const unauthorized = (message: string, code: string) =>
  APIError.fromStatus("UNAUTHORIZED", { message, code });

function checkMessage(siws: SiwsMessage, origin: URL, now: number): void {
  let uriOrigin: string | null = null;
  try {
    uriOrigin = new URL(siws.uri).origin;
  } catch {
    // An unparseable URI fails the origin check below.
  }
  if (siws.domain !== origin.host || uriOrigin !== origin.origin) {
    throw unauthorized("The message was not created for this site.", "SIWS_DOMAIN_MISMATCH");
  }
  if (siws.expirationTime !== undefined && now >= siws.expirationTime) {
    throw unauthorized("The sign-in message has expired.", "SIWS_EXPIRED");
  }
  if (siws.notBefore !== undefined && now < siws.notBefore) {
    throw unauthorized("The sign-in message is not valid yet.", "SIWS_NOT_YET_VALID");
  }
  const issuedAt = siws.issuedAt;
  if (
    issuedAt === undefined ||
    issuedAt > now + CLOCK_SKEW_MS ||
    now - issuedAt > MAX_MESSAGE_AGE_MS
  ) {
    throw unauthorized("The sign-in message is too old. Try again.", "SIWS_STALE");
  }
}

function shortAddress(ss58: string): string {
  return `${ss58.slice(0, 6)}…${ss58.slice(-4)}`;
}

export const siws = (options: SiwsOptions) => {
  const origin = new URL(options.origin);

  return {
    id: "siws",
    endpoints: {
      getSiwsNonce: createAuthEndpoint("/siws/nonce", { method: "POST" }, async (ctx) => {
        const nonce = generateRandomString(NONCE_LENGTH, "a-z", "A-Z", "0-9");
        await ctx.context.internalAdapter.createVerificationValue({
          identifier: `${NONCE_PREFIX}${nonce}`,
          value: nonce,
          expiresAt: new Date(Date.now() + NONCE_TTL_MS),
        });
        return ctx.json({ nonce });
      }),

      verifySiwsMessage: createAuthEndpoint(
        "/siws/verify",
        {
          method: "POST",
          body: z.object({
            message: z.string().min(1).max(4096),
            signature: z.string().regex(/^0x[0-9a-fA-F]{128,132}$/),
            /** The wallet account's own label, used as the display name for a new account. */
            name: z.string().trim().min(1).max(64).optional(),
          }),
          requireRequest: true,
        },
        async (ctx) => {
          const { message, signature, name } = ctx.body;

          let parsed: SiwsMessage;
          try {
            parsed = parseMessage(message);
          } catch {
            throw APIError.fromStatus("BAD_REQUEST", {
              message: "That is not a sign-in message.",
              code: "SIWS_MALFORMED",
            });
          }
          checkMessage(parsed, origin, Date.now());

          const address = Address.fromSs58(parsed.address);
          if (!address || address.isEthereum) {
            throw APIError.fromStatus("BAD_REQUEST", {
              message: "Use a Substrate account (Talisman, SubWallet or polkadot.js).",
              code: "SIWS_ADDRESS_INVALID",
            });
          }

          // One use per nonce, consumed before the signature check so a failed attempt cannot retry.
          const consumed = await ctx.context.internalAdapter.consumeVerificationValue(
            `${NONCE_PREFIX}${parsed.nonce}`,
          );
          if (!consumed)
            throw unauthorized("The sign-in request expired. Try again.", "SIWS_NONCE");

          if (!verifySignature(message, signature, address.bytes).isValid) {
            throw unauthorized("The wallet signature does not match.", "SIWS_SIGNATURE");
          }

          const accountId = address.toPubKey().toLowerCase();
          const ss58 = address.toSs58(SS58_PREFIX);
          const session = await getSessionFromCtx(ctx);
          const owner = await ctx.context.internalAdapter.findAccountOwnerByKey({
            providerId: PROVIDER_ID,
            accountId,
          });

          if (owner?.kind === "owned") {
            if (session && session.user.id !== owner.user.id) {
              throw APIError.fromStatus("CONFLICT", {
                message: "This wallet already belongs to another MemDot account.",
                code: "SIWS_WALLET_TAKEN",
              });
            }
          } else if (owner?.kind === "orphaned") {
            await ctx.context.internalAdapter.deleteAccount(owner.account.id);
          }

          // Signed in already: link the wallet to the current account and keep the session.
          if (session && owner?.kind !== "owned") {
            await ctx.context.internalAdapter.linkAccount({
              userId: session.user.id,
              providerId: PROVIDER_ID,
              accountId,
            });
            return ctx.json({ linked: true, user: { id: session.user.id, address: ss58 } });
          }
          if (session) {
            return ctx.json({ linked: true, user: { id: session.user.id, address: ss58 } });
          }

          let user: User;
          if (owner?.kind === "owned") {
            user = owner.user;
          } else {
            user = await ctx.context.internalAdapter.createUser(
              {
                name: name ?? shortAddress(ss58),
                email: placeholderEmail(accountId.slice(2), PROVIDER_ID),
                emailVerified: false,
              },
              { method: "siws" },
            );
            try {
              await ctx.context.internalAdapter.createAccount({
                userId: user.id,
                providerId: PROVIDER_ID,
                accountId,
              });
            } catch (error) {
              await ctx.context.internalAdapter.deleteUser(user.id);
              throw error;
            }
          }

          const created = await ctx.context.internalAdapter.createSession(user.id);
          if (!created) {
            throw APIError.fromStatus("INTERNAL_SERVER_ERROR", {
              message: "Could not start a session.",
            });
          }
          await setSessionCookie(ctx, { session: created, user });
          return ctx.json({
            linked: false,
            token: created.token,
            user: { id: user.id, address: ss58 },
          });
        },
      ),
    },
    rateLimit: [{ pathMatcher: (path) => path.startsWith("/siws/"), window: 60, max: 20 }],
  } satisfies BetterAuthPlugin;
};
