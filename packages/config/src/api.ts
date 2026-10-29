// Wire constants shared by the API, the SDKs and the CLI.

/** Every MemDot API key starts with this, so tools can spot a leaked key. */
export const API_KEY_PREFIX = "md_";

/** Random characters after the prefix (Better Auth default is 64). */
export const API_KEY_LENGTH = 48;

/** Characters kept in clear (prefix included) so the dashboard can label a key. */
export const API_KEY_VISIBLE_CHARS = 10;

/** Per-key request budget: 600 requests a minute. */
export const API_KEY_RATE_WINDOW_MS = 60_000;
export const API_KEY_RATE_MAX = 600;

/** Header the SDKs, CLI, MCP server and plugins set so the activity log can name the caller. */
export const CLIENT_HEADER = "x-memdot-client";

/** Header carrying a caller-chosen key that makes a write safe to retry. */
export const IDEMPOTENCY_HEADER = "idempotency-key";

/** Header echoed on every response so support can trace one request. */
export const REQUEST_ID_HEADER = "x-request-id";
