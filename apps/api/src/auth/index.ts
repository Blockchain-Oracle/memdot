import { apiKey } from "@better-auth/api-key";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { passkey } from "@better-auth/passkey";
import {
  API_KEY_LENGTH,
  API_KEY_PREFIX,
  API_KEY_VISIBLE_CHARS,
  DEFAULT_DISPLAY_NAME,
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
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
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
/** Sensitive actions (new recovery code, linking a passkey or wallet, new keys) need a sign-in this recent. */
export const FRESH_SESSION_SECONDS = 15 * 60;
/** How long a session check may be answered from the signed cookie instead of the database. */
const SESSION_COOKIE_CACHE_SECONDS = 60;
const DISPLAY_NAME_MAX = 64;

/** WebAuthn ceremonies whose responses must never carry the PRF output (R10, D4). */
const PASSKEY_VERIFY_PATHS = new Set([
  "/passkey/verify-registration",
  "/passkey/verify-authentication",
]);

export function isFresh(sessionCreatedAt: Date | string): boolean {
  return Date.now() - new Date(sessionCreatedAt).getTime() <= FRESH_SESSION_SECONDS * 1000;
}

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
  rateLimit: {
    storage: "database",
    customRules: {
      // Each new account costs a little (a sponsored space, a relayer-paid key bundle).
      "/passkey/generate-register-options": { window: 60, max: 10 },
      "/passkey/verify-registration": { window: 60, max: 10 },
    },
  },
  advanced: {
    cookiePrefix: "memdot",
    useSecureCookies: isProduction,
    crossSubDomainCookies: env.COOKIE_DOMAIN
      ? { enabled: true, domain: env.COOKIE_DOMAIN }
      : undefined,
    ipAddress: { trustedProxies: env.TRUSTED_PROXIES },
  },
  // Keys are minted through /v1/keys so every key carries a role; the raw plugin routes stay
  // closed to clients.
  disabledPaths: ["/api-key/create", "/api-key/update"],
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      // Adding a passkey to an existing account needs a recent sign-in, like a recovery code.
      if (ctx.path === "/passkey/generate-register-options") {
        const session = await getSessionFromCtx(ctx);
        if (session && !isFresh(session.session.createdAt)) {
          throw APIError.fromStatus("FORBIDDEN", {
            message: "Sign in again to add a passkey.",
            code: "SESSION_NOT_FRESH",
          });
        }
        return;
      }
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
      // Discoverable (username-less sign-in) and user-verified: PRF needs UV, and the passkey
      // guards the key.
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
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
    siws({ origin: env.WEB_ORIGIN, isFresh }),
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
      // Requests are counted in the API's own per-key limiter: verified keys are cached for 30 s,
      // so the plugin would only see cache misses.
      rateLimit: { enabled: false },
      permissions: { defaultPermissions: ROLE_PERMISSIONS.read_only },
    }),
  ],
});

export type Auth = typeof auth;
