import { CLIENT_HEADER, IDEMPOTENCY_HEADER, REQUEST_ID_HEADER } from "@memdot/config";
import type { MiddlewareHandler } from "hono";
import { cors } from "hono/cors";

/**
 * The dashboard's own address gets its session cookie. Anyone else's page can call the API with a key,
 * which is what the browser SDK is for: without allow-credentials, a browser won't send or read a
 * session from another address.
 */
export function corsFor(dashboardOrigin: string): MiddlewareHandler {
  const rules = {
    allowHeaders: ["content-type", "authorization", "x-api-key", IDEMPOTENCY_HEADER, CLIENT_HEADER],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    exposeHeaders: [REQUEST_ID_HEADER, "retry-after"],
    maxAge: 600,
  };
  const dashboard = cors({ ...rules, origin: dashboardOrigin, credentials: true });
  const open = cors({ ...rules, origin: "*" });
  return (c, next) => {
    if (c.req.header("origin") === dashboardOrigin) return dashboard(c, next);
    // The dashboard's answer already varies by origin. This one has to say so too, since the CID
    // gateway's responses are cached for a year.
    c.header("Vary", "Origin", { append: true });
    return open(c, next);
  };
}
