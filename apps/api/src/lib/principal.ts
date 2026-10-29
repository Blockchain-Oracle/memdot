import { API_KEY_PREFIX } from "@memdot/config";
import { accounts } from "@memdot/db";
import { and, eq, isNull } from "drizzle-orm";
import type { Context, MiddlewareHandler } from "hono";
import { auth } from "../auth/index.js";
import {
  API_KEY_ROLES,
  type ApiKeyMetadata,
  type ApiKeyRole,
  type Permissions,
} from "../auth/roles.js";
import { db } from "../db.js";
import type { AppEnv, Principal } from "../types.js";
import { forbidden, HttpError, unauthorized } from "./errors.js";

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
  const [row] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), isNull(accounts.deletedAt)))
    .limit(1);
  return row?.id ?? null;
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

/** Resolves the caller once per request. Routes then ask `principalOf` / `requireScope`. */
export const resolvePrincipal: MiddlewareHandler<AppEnv> = async (c, next) => {
  const key = presentedKey(c);
  if (!key) {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });
    c.set(
      "principal",
      session
        ? {
            userId: session.user.id,
            via: "session",
            accountId: await accountIdOf(session.user.id),
            apiKey: null,
          }
        : null,
    );
    return next();
  }

  const result = await auth.api.verifyApiKey({ body: { key } });
  if (!result.valid || !result.key) {
    if (result.error?.code === "RATE_LIMITED") {
      throw new HttpError(
        429,
        "RATE_LIMITED",
        "This API key is over its rate limit. Retry shortly.",
      );
    }
    throw unauthorized("That API key is not valid. It may have been revoked, rotated or expired.");
  }
  const metadata = metadataOf(result.key.metadata);
  c.set("principal", {
    userId: result.key.referenceId,
    via: "api_key",
    accountId: await accountIdOf(result.key.referenceId),
    apiKey: {
      id: result.key.id,
      start: result.key.start,
      role: metadata.role,
      permissions: (result.key.permissions ?? {}) as Permissions,
      spaceIds: metadata.spaceIds,
      agentId: metadata.agentId ?? null,
    },
  });
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

/** Space-scoped keys only reach their own spaces. */
export function assertSpaceAllowed(principal: Principal, spaceId: string): void {
  const allowed = principal.apiKey?.spaceIds;
  if (allowed && !allowed.includes(spaceId)) {
    throw forbidden("This API key is limited to other spaces.");
  }
}
