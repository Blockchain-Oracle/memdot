// Product limits. MAX_FILE_BYTES and quotas are provisional until the tPOT supply is known
// (context research task U1); every value is overridable through env in the service.

/** Files at or below this size are packed into a shared segment instead of stored alone. */
export const TINY_FILE_BYTES = 65_536;

/** Default per-file cap for sponsored spaces (storing costs ≈105 tPOT per MiB). */
export const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024;

/** Time allowed for one `bitswap_v1_get` before the read is retried or fails. */
export const BITSWAP_TIMEOUT_MS = 30_000;

/**
 * Ciphertext a sponsored space may hold (the relayer pays ≈105 tPOT per MiB stored, plus
 * renewals). Provisional until the testnet tPOT budget is known; the API reads an env override.
 */
export const SPONSORED_QUOTA_BYTES = 1024 * 1024;

export const MAX_SPACES_PER_ACCOUNT = 10;

/** Encrypted names and file metadata (name + MIME sealed to the space key). */
export const MAX_ENCRYPTED_META_BYTES = 4_096;

/** Key bundles and wrapped grant keys are tiny; they are account objects outside any quota. */
export const MAX_SYSTEM_OBJECT_BYTES = 16_384;

/** Live key bundles and grant keys per account: the relayer pays for them, so they are capped. */
export const MAX_SYSTEM_OBJECTS = 200;

/** "Renew now" skips blobs stored or renewed within this many blocks (one hour). */
export const RENEW_NOW_MIN_AGE_BLOCKS = 600;

/** Ciphertext the API keeps on local disk for the CID gateway before evicting the oldest. */
export const GATEWAY_CACHE_BYTES = 512 * 1024 * 1024;

/** Default and largest page for list endpoints. */
export const PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/** Segment entries registered per call (JSON bodies are capped at 1 MiB). */
export const MAX_SEGMENT_ENTRIES = 150;
/** Plaintext packed into one segment before sealing; stays under one chunk with header room. */
export const SEGMENT_PACK_BYTES = 6_000_000;
