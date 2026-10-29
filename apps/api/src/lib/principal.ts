import { createHash } from "node:crypto";
import { API_KEY_PREFIX, API_KEY_RATE_MAX, API_KEY_RATE_WINDOW_MS } from "@memdot/config";
import { accounts } from "@memdot/db";
import { and, eq, isNull } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { auth, isFresh } from "../auth/index.js";
import {
  API_KEY_ROLES,
  type ApiKeyMetadata,
  type ApiKeyRole,
  type Permissions,
} from "../auth/roles.js";
import { db } from "../db.js";
import type { AppEnv, Principal } from "../types.js";
import { forbidden, HttpError, unauthorized } from "./errors.js";
import { RateLimiter } from "./rate-limit.js";
import { TtlCache } from "./ttl-cache.js";

/** API-key principals are reused this long, so each key costs at most two writes a window. */
const KEY_CACHE_MS = 30_000;
const ACCOUNT_CACHE_MS = 60_000;
const CACHE_ENTRIES = 10_000;

const keyCache = new TtlCache<Principal>(KEY_CACHE_MS, CACHE_ENTRIES);
const accountCache = new TtlCache<string | null>(ACCOUNT_CACHE_MS, CACHE_ENTRIES);
/** Per-key budget, enforced here because cached principals skip the plugin's own counter. */
const keyLimiter = new RateLimiter(API_KEY_RATE_MAX, API_KEY_RATE_WINDOW_MS);

/** Call after a key is deleted or rotated, or an agent revoked: cached keys stop working at once. */
export function forgetApiKeys(): void {
  keyCache.clear();
}

/** Call after account setup changes, so the next request sees the account. */
export function forgetAccount(userId: string): void {
  accountCache.delete(userId);
  keyCache.clear();
}

/** `Authorization: Bearer md_…` (SDKs, CLI) or `x-api-key: md_…` (integrations that only set one header). */
function presentedKey(c: Context): string | null {
  const header = c.req.header("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) {
    const token = header.slice("bearer ".length).trim();
    if (token.startsWith(API_KEY_PREFIX)) return token;
  }
  return c.req.header("x-api-key")?.trim() || null;
}

async function accountIdOf(userId: string): Promise<string | null> {
  const cached = accountCache.get(userId);
  if (cached !== undefined) return cached;
  const [row] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), isNull(accounts.deletedAt)))
    .limit(1);
  const accountId = row?.id ?? null;
  accountCache.set(userId, accountId);
  return accountId;
}

function metadataOf(raw: unknown): ApiKeyMetadata {
  const value = (typeof raw === "string" ? JSON.parse(raw) : raw) as Partial<ApiKeyMetadata> | null;
  const role: ApiKeyRole = API_KEY_ROLES.includes(value?.role as ApiKeyRole)
    ? (value?.role as ApiKeyRole)
    : "read_only";
  return {
    role,
    spaceIds: Array.isArray(value?.spaceIds) ? value.spaceIds : null,
    ...(value?.agentId ? { agentId: value.agentId } : {}),
  };
}

async function principalForKey(key: string): Promise<Principal> {
  const digest = createHash("sha256").update(key).digest("hex");
  const cached = keyCache.get(digest);
  if (cached) return cached;
  const result = await auth.api.verifyApiKey({ body: { key } });
  if (!result.valid || !result.key) {
    throw unauthorized("That API key is not valid. It may have been revoked, rotated or expired.");
  }
  const metadata = metadataOf(result.key.metadata);
  const principal: Principal = {
    userId: result.key.referenceId,
    via: "api_key",
    accountId: await accountIdOf(result.key.referenceId),
    sessionCreatedAt: null,
    apiKey: {
      id: result.key.id,
      start: result.key.start,
      role: metadata.role,
      permissions: (result.key.permissions ?? {}) as Permissions,
      spaceIds: metadata.spaceIds,
      agentId: metadata.agentId ?? null,
    },
  };
  keyCache.set(digest, principal);
  return principal;
}

/** Resolves the caller once per request. Routes then ask `principalOf` / `requireScope`. */
export const resolvePrincipal: MiddlewareHandler<AppEnv> = async (c, next) => {
  const key = presentedKey(c);
  if (!key) {
    // Better Auth may refresh the session or its cookie cache here; pass those cookies on.
    const { headers, response: session } = await auth.api.getSession({
      headers: c.req.raw.headers,
      returnHeaders: true,
    });
    for (const cookie of headers.getSetCookie()) c.header("set-cookie", cookie, { append: true });
    c.set(
      "principal",
      session
        ? {
            userId: session.user.id,
            via: "session",
            accountId: await accountIdOf(session.user.id),
            sessionCreatedAt: new Date(session.session.createdAt),
            apiKey: null,
          }
        : null,
    );
    return next();
  }

  const principal = await principalForKey(key);
  const retryAfter = keyLimiter.hit(principal.apiKey?.id ?? key);
  if (retryAfter > 0) {
    c.header("retry-after", String(retryAfter));
    throw new HttpError(429, "RATE_LIMITED", "This API key is over its rate limit. Retry shortly.");
  }
  c.set("principal", principal);
  return next();
};

export function principalOf(c: Context<AppEnv>): Principal {
  const principal = c.get("principal");
  if (!principal) throw unauthorized();
  return principal;
}

/** The MemDot account; routes that touch spaces and objects need setup to be finished. */
export function accountOf(c: Context<AppEnv>): string {
  const principal = principalOf(c);
  if (!principal.accountId) {
    throw new HttpError(
      409,
      "ACCOUNT_SETUP_REQUIRED",
      "Finish setting up your MemDot account first.",
    );
  }
  return principal.accountId;
}

export function can(principal: Principal, resource: string, action: string): boolean {
  if (!principal.apiKey) return true;
  return principal.apiKey.permissions[resource]?.includes(action) ?? false;
}

/** Route guard: signed in, and an API key (if used) carries `resource:action`. */
export function requireScope(resource: string, action: string): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const principal = principalOf(c);
    if (!can(principal, resource, action)) {
      throw forbidden(
        `This API key (${principal.apiKey?.role}) cannot ${action} ${resource}. Use a key with more access.`,
      );
    }
    await next();
  };
}

/**
 * Durable credentials (a new passkey, wallet, API key) and key changes outlive a session, so a
 * stolen session cookie must not be enough: they need a sign-in from the last few minutes.
 */
export function assertFreshSession(principal: Principal): void {
  if (principal.via !== "session") return;
  if (!principal.sessionCreatedAt || !isFresh(principal.sessionCreatedAt)) {
    throw new HttpError(403, "SESSION_NOT_FRESH", "Sign in again to confirm this change.");
  }
}

/** Space-scoped keys only reach their own spaces. */
export function assertSpaceAllowed(principal: Principal, spaceId: string): void {
  const allowed = principal.apiKey?.spaceIds;
  if (allowed && !allowed.includes(spaceId)) {
    throw forbidden("This API key is limited to other spaces.");
  }
}

/** A dashboard session, or an API key limited to no space and no agent. */
export function isAccountWide(principal: Principal): boolean {
  return !principal.apiKey || (!principal.apiKey.spaceIds && !principal.apiKey.agentId);
}

/**
 * Route guard for account-level powers (minting or rotating keys, managing agents, reading the
 * whole request log). A key limited to some spaces or to one agent must not be able to grant
 * itself more than it has.
 */
export const requireAccountWide: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!isAccountWide(principalOf(c))) {
    throw forbidden("Use the dashboard or an account-wide management key for this.");
  }
  await next();
};
