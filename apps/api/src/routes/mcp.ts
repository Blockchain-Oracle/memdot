import { requireMcpAuth } from "@better-auth/mcp";
import { API_KEY_PREFIX } from "@memdot/config";
import { buildServer } from "@memdot/mcp";
import { MemDot } from "@memdot/sdk";
import { createMcpHandler } from "@modelcontextprotocol/server";
import type { Hono } from "hono";
import { auth, MCP_RESOURCE } from "../auth/index.js";
import { env } from "../env.js";
import { HttpError } from "../lib/errors.js";
import { hitKeyLimit, principalForKey, principalForOAuth } from "../lib/principal.js";
import type { AppEnv, Principal } from "../types.js";

const VERSION = "0.1.0";
const PROTECTED_RESOURCE_METADATA = `${env.API_URL}/.well-known/oauth-protected-resource/mcp`;

function bearerOf(request: Request): string | null {
  const header = request.headers.get("authorization");
  return header?.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : null;
}

/** MCP clients read errors as JSON-RPC; a 401 with this header sends them back through sign-in. */
function refuse(error: HttpError, requestId: string): Response {
  const headers = new Headers({ "content-type": "application/json" });
  if (error.status === 401) {
    headers.set(
      "www-authenticate",
      `Bearer error="invalid_token", error_description="${error.message}", resource_metadata="${PROTECTED_RESOURCE_METADATA}"`,
    );
  }
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32001, message: error.message, data: { requestId } },
    }),
    { status: error.status, headers },
  );
}

/**
 * Hosted MCP, over Streamable HTTP: OAuth for clients that can sign in, or an `md_` key as a bearer
 * for ones that can't. The server holds no one's keys, so it offers Assisted memory only. Tools run
 * the same SDK as everything else, calling this API in-process as the caller already verified.
 */
export function mcpRoutes(app: () => Hono<AppEnv>) {
  const handler = createMcpHandler(({ authInfo }) => {
    const principal = authInfo?.extra?.principal as Principal;
    const memdot = MemDot.create({
      baseUrl: env.API_URL,
      client: `mcp-hosted/${VERSION}`,
      fetch: (input, init) =>
        Promise.resolve(
          app().request(input as Request | string, init, { internalPrincipal: principal }),
        ),
    });
    const hosted = principal.apiKey?.hosted;
    return buildServer(memdot, {
      version: VERSION,
      mode: "hosted",
      namespaceId: hosted?.namespaceId ?? null,
      namespaces: hosted?.namespaces ?? null,
      // A new memory has to be about someone; here that's the person who connected it.
      userId: "me",
      readOnly: principal.apiKey?.role === "read_only",
    });
  });

  const serve = async (
    request: Request,
    principal: Principal,
    clientId: string,
    expiresAt: number,
  ) => {
    const retryAfter = hitKeyLimit(principal.apiKey?.id ?? clientId);
    if (retryAfter > 0) {
      return refuse(
        new HttpError(429, "RATE_LIMITED", "Too many calls. Retry shortly."),
        crypto.randomUUID(),
      );
    }
    return handler.fetch(request, {
      authInfo: {
        token: "",
        clientId,
        scopes: [],
        expiresAt,
        extra: { principal },
      },
    });
  };

  const withOAuth = requireMcpAuth(
    auth,
    async (request, claims) => {
      try {
        const principal = await principalForOAuth(claims.sub ?? "", String(claims.azp));
        return await serve(request, principal, String(claims.azp), claims.exp ?? 0);
      } catch (error) {
        if (error instanceof HttpError) return refuse(error, crypto.randomUUID());
        throw error;
      }
    },
    // The keys come from this same process: no need to go out through the proxy and back.
    { resource: MCP_RESOURCE, jwksUrl: `http://127.0.0.1:${env.PORT}/api/auth/jwks` },
  );

  return async (request: Request): Promise<Response> => {
    const bearer = bearerOf(request);
    if (!bearer?.startsWith(API_KEY_PREFIX)) return withOAuth(request);
    try {
      const principal = await principalForKey(bearer);
      return await serve(request, principal, principal.apiKey?.id ?? "", NO_TOKEN_EXPIRY);
    } catch (error) {
      if (error instanceof HttpError) return refuse(error, crypto.randomUUID());
      throw error;
    }
  };
}

/** An `md_` key has no expiry for this call to care about: it was checked just now. */
const NO_TOKEN_EXPIRY = Number.MAX_SAFE_INTEGER;
