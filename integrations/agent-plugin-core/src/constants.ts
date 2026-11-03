export const PLUGIN_VERSION = "0.1.0";
export const MAX_CLI_DOWNLOAD_BYTES = 50 * 1024 * 1024;

/** A first prompt shorter than this has nothing to search on. */
export const MIN_QUERY_CHARS = 20;
export const MAX_QUERY_CHARS = 2_000;
export const RECALL_TOP_K = 5;
/** Below the hook's own limit, so a slow search ends here rather than being killed. */
export const RECALL_TIMEOUT_MS = 10_000;
export const DEFAULT_TOP_K = 5;
export const DEFAULT_MAX_CONTEXT_CHARS = 4_000;
export const MIN_CONTEXT_CHARS = 1_000;
export const MAX_CONTEXT_CHARS = 10_000;

/**
 * Every checkpoint costs a model call and a chain write, and both are budgeted, so this saves after
 * real work rather than on a short timer. Anything left over goes at compaction or session end.
 */
export const DEFAULT_CHECKPOINT_EXCHANGES = 10;
export const CHECKPOINT_CHARS = 40_000;
/** A quick question and its answer: not worth a model call or a chain write. */
export const MIN_PACKET_CHARS = 400;

export const MAX_COMMAND_CHARS = 2_000;
export const MAX_RESULT_CHARS = 2_500;
export const MAX_FIELD_CHARS = 1_000;
export const MAX_MESSAGE_CHARS = 8_000;
export const MAX_PACKET_CHARS = 48_000;
export const MAX_CHANGED_PATHS = 20;
export const MAX_FAILED_COMMANDS = 10;
export const MAX_NOTE_CHARS = 2_000;

export const FLUSH_TIMEOUT_MS = 5 * 60_000;
export const CLI_TIMEOUT_MS = 60_000;
export const WARM_TIMEOUT_MS = 10 * 60_000;
export const DOWNLOAD_TIMEOUT_MS = 2 * 60_000;

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
/** Maintenance runs from every session start, but there's no point doing it more than this. */
export const MAINTAIN_EVERY_MS = 10 * MINUTE_MS;
/** A session untouched this long has crashed or been left: what it holds gets saved. */
export const ABANDONED_AFTER_MS = 30 * MINUTE_MS;
export const STALE_LOCK_MS = 5 * MINUTE_MS;
/** Failures that aren't this packet's fault wait, instead of using up its attempts. */
export const RETRY_NETWORK_MS = 10 * MINUTE_MS;
export const RETRY_AUTH_MS = HOUR_MS;
export const RETRY_LIMITED_MS = 6 * HOUR_MS;
export const RETRY_FAILED_MS = 30 * MINUTE_MS;
export const RETRY_OTHER_LOGIN_MS = HOUR_MS;
export const MAX_PACKET_ATTEMPTS = 5;
export const PACKET_TTL_MS = 7 * DAY_MS;
/** What a saved session leaves on this machine is removed this long after it goes quiet. */
export const SESSION_TTL_MS = DAY_MS;
export const FAILED_TTL_MS = 14 * DAY_MS;
/** Nothing in the background should outlast this, however it got stuck. */
export const WORKER_DEADLINE_MS = 30 * MINUTE_MS;
export const LOCK_HEARTBEAT_MS = MINUTE_MS;
export const MAX_ERROR_LOG_BYTES = 256 * 1024;

/** Exit codes from the CLI. */
export const EXIT_USAGE = 2;
export const EXIT_AUTH = 3;
export const EXIT_NOT_FOUND = 4;
export const EXIT_LIMITED = 6;
export const EXIT_NETWORK = 7;
