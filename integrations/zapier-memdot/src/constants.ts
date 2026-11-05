// The temporary address until memdot.xyz. A connection can override it, for self-hosted MemDot.
export const DEFAULT_API_URL = "https://api.84.46.247.92.sslip.io";
export const CLIENT = "zapier";

/** Zapier stops a step at 30 seconds, so leave room for the request before and after the wait. */
export const INDEX_WAIT_MS = 15_000;
export const POLL_MS = 1_000;

export const DEFAULT_TOP_K = 10;
export const MAX_RESULTS = 100;
export const NEW_MEMORY_PAGE = 50;
/** The editor's test only needs a look at the shape. */
export const SAMPLE_PAGE = 3;
export const ID_CHARS = 8;
/** Enough to tell two connections apart, and far too little to use. */
export const KEY_PREFIX_CHARS = 10;
