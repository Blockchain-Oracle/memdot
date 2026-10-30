import { MemDotError } from "@memdot/sdk";
import { QueryClient } from "@tanstack/react-query";

const STALE_MS = 30_000;
const MAX_RETRIES = 2;

export function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: STALE_MS,
        // A 4xx will not change on retry (signed out, locked, not found, quota): show it now.
        retry: (count, error) =>
          !(error instanceof MemDotError && error.status < 500) && count < MAX_RETRIES,
      },
      mutations: { retry: false },
    },
  });
}
