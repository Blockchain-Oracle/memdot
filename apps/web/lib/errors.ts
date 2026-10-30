import { LockedError, MemDotError } from "@memdot/sdk";

/** One line for a toast or an inline error, with the request id when the API gave one. */
export function describeError(error: unknown): { title: string; requestId: string | null } {
  if (error instanceof MemDotError) return { title: error.message, requestId: error.requestId };
  if (error instanceof LockedError) return { title: error.message, requestId: null };
  if (error instanceof TypeError && /fetch/i.test(error.message)) {
    return { title: "MemDot's API is not reachable. Check your connection.", requestId: null };
  }
  return {
    title: error instanceof Error ? error.message : "Something went wrong.",
    requestId: null,
  };
}

export const isCancelled = (error: unknown) =>
  error instanceof MemDotError &&
  (error.code === "PASSKEY_CANCELLED" || error.code === "WALLET_CANCELLED");
