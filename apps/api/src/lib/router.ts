import { OpenAPIHono } from "@hono/zod-openapi";
import type { AppEnv } from "../types.js";
import { ErrorSchema, validationHook } from "./errors.js";

/** Every route module builds on this, so validation errors look the same everywhere. */
export function createRouter() {
  return new OpenAPIHono<AppEnv>({ defaultHook: validationHook });
}

const json = { "application/json": { schema: ErrorSchema } } as const;

/** Error responses most routes can return, for the OpenAPI document. */
export const errorResponses = {
  400: { description: "The request is not valid.", content: json },
  401: { description: "Sign in or pass an API key.", content: json },
  403: { description: "The API key lacks this permission or space.", content: json },
  404: { description: "Not found.", content: json },
  409: { description: "Conflicts with the current state.", content: json },
  429: { description: "Rate limited.", content: json },
} as const;

/** Both ways to authenticate, for routes that accept either. */
export const authenticated = [{ ApiKey: [] }, { Session: [] }];
