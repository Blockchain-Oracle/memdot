// Product limits. MAX_FILE_BYTES and quotas are provisional until the tPOT supply is known
// (context research task U1); every value is overridable through env in the service.

/** Files at or below this size are packed into a shared segment instead of stored alone. */
export const TINY_FILE_BYTES = 65_536;

/** Default per-file cap for sponsored spaces (storing costs ≈105 tPOT per MiB). */
export const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024;

/** Time allowed for one `bitswap_v1_get` before the read is retried or fails. */
export const BITSWAP_TIMEOUT_MS = 30_000;
