import { apiKey } from "@better-auth/api-key";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { passkey } from "@better-auth/passkey";
import {
  API_KEY_LENGTH,
  API_KEY_PREFIX,
  API_KEY_RATE_MAX,
  API_KEY_RATE_WINDOW_MS,
  API_KEY_VISIBLE_CHARS,
  EVM_CHAIN_ID,
} from "@memdot/config";
import {
  account,
  apikey,
  passkey as passkeyTable,
  rateLimit,
  session,
  user,
  verification,
  walletAddress,
} from "@memdot/db";
import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { siwe } from "better-auth/plugins";
import { type Hex, verifyMessage } from "viem";
import { generateSiweNonce } from "viem/siwe";
import { db } from "../db.js";
import { env, isProduction } from "../env.js";
import { placeholderEmail } from "./placeholder.js";
import { recoveryCode } from "./recovery.js";
import { ROLE_PERMISSIONS } from "./roles.js";
import { siws } from "./siws.js";

const SESSION_DAYS = 30;
const DAY_SECONDS = 24 * 60 * 60;
/** Sensitive actions (new recovery code, removing a passkey) need a sign-in this recent. */
const FRESH_SESSION_SECONDS = 15 * 60;
/** How long a session check may be answered from the signed cookie instead of the database. */
const SESSION_COOKIE_CACHE_SECONDS = 60;
const DISPLAY_NAME_MAX = 64;
const DEFAULT_DISPLAY_NAME = "MemDot account";

/** WebAuthn ceremonies whose responses must never carry the PRF output (R10, D4). */
const PASSKEY_VERIFY_PATHS = new Set([
  "/passkey/verify-registration",
  "/passkey/verify-authentication",
]);

function displayName(context: string | null | undefined): string {
  const name = context?.trim().slice(0, DISPLAY_NAME_MAX);
  return name || DEFAULT_DISPLAY_NAME;
}

export const auth = betterAuth({
  appName: "MemDot",
  baseURL: env.API_URL,
  basePath: "/api/auth",
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: [env.WEB_ORIGIN],
  database: drizzleAdapter(db, {
    provider: "pg",
    schemaName: "auth",
    transaction: true,
    schema: {
      user,
      session,
      account,
      verification,
      passkey: passkeyTable,
      walletAddress,
      apikey,
      rateLimit,
    },
  }),
  session: {
    expiresIn: SESSION_DAYS * DAY_SECONDS,
    updateAge: DAY_SECONDS,
    freshAge: FRESH_SESSION_SECONDS,
    cookieCache: { enabled: true, maxAge: SESSION_COOKIE_CACHE_SECONDS },
  },
  rateLimit: { storage: "database" },
  advanced: {
    cookiePrefix: "memdot",
    useSecureCookies: isProduction,
    crossSubDomainCookies: env.COOKIE_DOMAIN
      ? { enabled: true, domain: env.COOKIE_DOMAIN }
      : undefined,
  },
  // Keys are minted through /v1/keys so every key carries a role; the raw plugin routes stay
  // closed to clients.
  disabledPaths: ["/api-key/create", "/api-key/update"],
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (!PASSKEY_VERIFY_PATHS.has(ctx.path)) return;
      if (ctx.body?.response?.clientExtensionResults?.prf?.results) {
        throw APIError.fromStatus("BAD_REQUEST", {
          message: "The passkey's PRF output must stay on this device.",
          code: "PRF_OUTPUT_SENT",
        });
      }
    }),
  },
  plugins: [
    passkey({
      rpID: env.RP_ID,
      rpName: "MemDot",
      origin: env.WEB_ORIGIN,
      registration: {
        // Passkey-first sign-up: no account exists until the ceremony succeeds.
        requireSession: false,
        resolveUser: async ({ context }) => ({
          id: crypto.randomUUID(),
          name: displayName(context),
        }),
        afterVerification: async ({ ctx, user }) => {
          const adapter = ctx.context.internalAdapter;
          if (await adapter.findUserById(user.id)) return {};
          const created = await adapter.createUser(
            {
              name: user.name,
              email: placeholderEmail(user.id, "passkey"),
              emailVerified: false,
            },
            { method: "passkey" },
          );
          return { userId: created.id };
        },
      },
    }),
    siws({ origin: env.WEB_ORIGIN }),
    siwe({
      domain: new URL(env.WEB_ORIGIN).host,
      emailDomainName: "siwe.placeholder.invalid",
      anonymous: true,
      getNonce: async () => generateSiweNonce(),
      verifyMessage: async ({ message, signature, address, chainId }) => {
        if (chainId !== EVM_CHAIN_ID) return false;
        return verifyMessage({
          address: address as Hex,
          message,
          signature: signature as Hex,
        }).catch(() => false);
      },
    }),
    recoveryCode(),
    apiKey({
      defaultPrefix: API_KEY_PREFIX,
      defaultKeyLength: API_KEY_LENGTH,
      startingCharactersConfig: { shouldStore: true, charactersLength: API_KEY_VISIBLE_CHARS },
      enableMetadata: true,
      requireName: true,
      rateLimit: {
        enabled: true,
        timeWindow: API_KEY_RATE_WINDOW_MS,
        maxRequests: API_KEY_RATE_MAX,
      },
      permissions: { defaultPermissions: ROLE_PERMISSIONS.read_only },
    }),
  ],
});

export type Auth = typeof auth;
