import { z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { AppEnv } from "../types.js";

/** Every error response has this shape, with the request id for support. */
export const ErrorSchema = z
  .object({
    error: z.object({
      code: z.string().openapi({ example: "QUOTA_EXCEEDED" }),
      message: z.string().openapi({ example: "This upload would exceed the space's quota." }),
      requestId: z.string(),
      details: z.unknown().optional(),
    }),
  })
  .openapi("Error");

/** An error a handler throws on purpose; the message is shown to the user as is. */
export class HttpError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new HttpError(400, code, message, details);
export const unauthorized = (message = "Sign in or pass an API key.") =>
  new HttpError(401, "UNAUTHORIZED", message);
export const forbidden = (message: string) => new HttpError(403, "FORBIDDEN", message);
export const notFound = (what: string) => new HttpError(404, "NOT_FOUND", `${what} not found.`);
export const conflict = (code: string, message: string) => new HttpError(409, code, message);

function body(c: Context<AppEnv>, code: string, message: string, details?: unknown) {
  return {
    error: { code, message, requestId: c.get("requestId") ?? "", ...(details ? { details } : {}) },
  };
}

export function errorResponse(error: Error, c: Context<AppEnv>) {
  if (error instanceof HttpError) {
    return c.json(body(c, error.code, error.message, error.details), error.status);
  }
  if (error instanceof HTTPException) {
    return c.json(body(c, "HTTP_ERROR", error.message), error.status);
  }
  console.error(`[api] ${c.req.method} ${c.req.path} ${c.get("requestId")}`, error);
  return c.json(body(c, "INTERNAL", "Something went wrong on our side."), 500);
}

/** Used by every OpenAPI route: a failed schema check becomes one consistent 400. */
export function validationHook(
  result: { success: true } | { success: false; error: z.ZodError },
  c: Context<AppEnv>,
) {
  if (result.success) return;
  const issues = result.error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
  return c.json(body(c, "VALIDATION", "The request is not valid.", issues), 400);
}
