import { CLIENT_HEADER, IDEMPOTENCY_HEADER, REQUEST_ID_HEADER } from "@memdot/config";
import { Scalar } from "@scalar/hono-api-reference";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { requestId } from "hono/request-id";
import { secureHeaders } from "hono/secure-headers";
import { auth } from "./auth/index.js";
import { env } from "./env.js";
import { errorResponse } from "./lib/errors.js";
import { resolvePrincipal } from "./lib/principal.js";
import { RateLimiter, rateLimit } from "./lib/rate-limit.js";
import { createRouter } from "./lib/router.js";
import { accountRoutes } from "./routes/account.js";
import { activityRoutes } from "./routes/activity.js";
import { agentRoutes } from "./routes/agents.js";
import { folderRoutes } from "./routes/folders.js";
import { gatewayRoutes } from "./routes/gateway.js";
import { grantRoutes } from "./routes/grants.js";
import { healthRoutes } from "./routes/health.js";
import { jobRoutes } from "./routes/jobs.js";
import { keyRoutes } from "./routes/keys.js";
import { objectRoutes } from "./routes/objects.js";
import { proofRoutes } from "./routes/proof.js";
import { sharedRoutes } from "./routes/shared.js";
import { spaceRoutes } from "./routes/spaces.js";
import { usageRoutes } from "./routes/usage.js";
import type { Services } from "./types.js";

/** Dashboard sessions: generous, since one page fires several queries. */
const SESSION_RATE = { max: 1_200, windowMs: 60_000 };
/** JSON bodies are small; only blob uploads (their own 7 MB limit) carry real payloads. */
const JSON_BODY_LIMIT = 1024 * 1024;
const BLOB_UPLOAD_PATH = /^\/v1\/objects\/[^/]+\/blobs\/[^/]+\/[^/]+$/;

export function createApp(services: Services) {
  const app = createRouter();
  const sessionLimiter = new RateLimiter(SESSION_RATE.max, SESSION_RATE.windowMs);

  app.onError(errorResponse);
  app.notFound((c) =>
    c.json(
      { error: { code: "NOT_FOUND", message: "No such route.", requestId: c.get("requestId") } },
      404,
    ),
  );

  app.use("*", requestId({ headerName: REQUEST_ID_HEADER }));
  app.use("*", secureHeaders({ crossOriginResourcePolicy: "cross-origin" }));
  app.use(
    "*",
    cors({
      origin: env.WEB_ORIGIN,
      credentials: true,
      allowHeaders: [
        "content-type",
        "authorization",
        "x-api-key",
        IDEMPOTENCY_HEADER,
        CLIENT_HEADER,
      ],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      exposeHeaders: [REQUEST_ID_HEADER, "retry-after"],
      maxAge: 600,
    }),
  );

  const jsonLimit = bodyLimit({
    maxSize: JSON_BODY_LIMIT,
    onError: (c) =>
      c.json(
        {
          error: {
            code: "TOO_LARGE",
            message: "The request body is too large.",
            requestId: c.get("requestId"),
          },
        },
        413,
      ),
  });
  app.use("/api/auth/*", jsonLimit);
  app.use("/v1/*", (c, next) =>
    c.req.method === "PUT" && BLOB_UPLOAD_PATH.test(c.req.path) ? next() : jsonLimit(c, next),
  );

  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));

  app.route("/", healthRoutes(services));

  app.use("/v1/*", resolvePrincipal);
  app.use(
    "/v1/*",
    rateLimit(sessionLimiter, (c) => {
      const principal = c.get("principal");
      return principal?.via === "session" ? principal.userId : null;
    }),
  );
  app.use("/v1/*", async (c, next) => {
    const started = performance.now();
    await next();
    const principal = c.get("principal");
    if (!principal) return;
    services.requestLog.record({
      accountId: principal.accountId,
      apiKeyPrefix: principal.apiKey?.start ?? null,
      client:
        c.req.header(CLIENT_HEADER)?.slice(0, 64) ??
        (principal.via === "session" ? "dashboard" : null),
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      latencyMs: Math.round(performance.now() - started),
      requestId: c.get("requestId"),
    });
  });

  app
    .route("/", accountRoutes())
    .route("/", spaceRoutes())
    .route("/", folderRoutes())
    .route("/", objectRoutes(services))
    .route("/", gatewayRoutes(services))
    .route("/", grantRoutes())
    .route("/", sharedRoutes(services))
    .route("/", keyRoutes())
    .route("/", agentRoutes())
    .route("/", jobRoutes(services))
    .route("/", usageRoutes(services))
    .route("/", activityRoutes())
    .route("/", proofRoutes(services));

  app.openAPIRegistry.registerComponent("securitySchemes", "ApiKey", {
    type: "http",
    scheme: "bearer",
    description: "An API key from the dashboard (starts with md_).",
  });
  app.openAPIRegistry.registerComponent("securitySchemes", "Session", {
    type: "apiKey",
    in: "cookie",
    name: "memdot.session_token",
    description: "The dashboard's session cookie.",
  });
  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info: {
      title: "MemDot API",
      version: "1.0.0",
      description:
        "Encrypted storage on Portaldot V3 for apps, files and agent memory. Clients encrypt; the API only ever sees ciphertext.",
    },
    servers: [{ url: env.API_URL }],
  });
  app.get("/docs", Scalar({ url: "/openapi.json", pageTitle: "MemDot API" }));

  return app;
}

export type App = ReturnType<typeof createApp>;
