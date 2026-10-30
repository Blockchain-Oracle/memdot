"use client";

import { type Me, MemDotError } from "@memdot/sdk";
import { useQuery } from "@tanstack/react-query";
import { useMemDot, useUnlocked } from "./memdot";

export const ME_KEY = ["me"] as const;

/** The signed-in user and account; null when signed out. */
export function useMe() {
  const memdot = useMemDot();
  return useQuery({
    queryKey: ME_KEY,
    queryFn: async (): Promise<Me | null> => {
      try {
        return await memdot.account.me();
      } catch (error) {
        if (error instanceof MemDotError && error.status === 401) return null;
        throw error;
      }
    },
    staleTime: 60_000,
  });
}

export type Gate = "loading" | "offline" | "sign-in" | "setup" | "unlock" | "ready";

/** Where this visitor stands: API unreachable, signed out, mid-setup, locked, or ready. */
export function useGate(): { gate: Gate; me: Me | null | undefined; retry: () => void } {
  const { data: me, isPending, isError, refetch } = useMe();
  const unlocked = useUnlocked();
  const retry = () => void refetch();
  if (isPending) return { gate: "loading", me, retry };
  // A network failure is not a sign-out: keep the visitor where they are.
  if (isError && me === undefined) return { gate: "offline", me, retry };
  if (!me) return { gate: "sign-in", me, retry };
  if (!me.account?.keyBundleCid) return { gate: "setup", me, retry };
  if (!unlocked) return { gate: "unlock", me, retry };
  return { gate: "ready", me, retry };
}

export const HOME = "/overview";

/** A same-site path to return to after unlocking (never an open redirect). */
export function safeNext(next: string | null): string {
  return next?.startsWith("/") && !next.startsWith("//") ? next : HOME;
}
