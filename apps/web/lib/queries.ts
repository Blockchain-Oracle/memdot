"use client";

import type { Job, Space } from "@memdot/sdk";
import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { useMemDot } from "./memdot";

export const TERMINAL: ReadonlySet<Job["status"]> = new Set(["finalized", "failed"]);
const ACTIVE_POLL_MS = 2_000;
const IDLE_POLL_MS = 20_000;
const RECENT_JOBS = 20;
const LAST_SPACE_KEY = "memdot:space";

export function useSpaces() {
  const memdot = useMemDot();
  return useQuery({ queryKey: ["spaces"], queryFn: () => memdot.spaces.list() });
}

/** The space in the URL, else the last one used on this device, else the first. */
export function useCurrentSpace(): { space: Space | undefined; isPending: boolean } {
  const { data: spaces, isPending } = useSpaces();
  const params = useParams<{ spaceId?: string }>();
  const [remembered, setRemembered] = useState<string | null>(null);

  useEffect(() => {
    try {
      setRemembered(localStorage.getItem(LAST_SPACE_KEY));
    } catch {
      // Storage can be blocked; fall back to the first space.
    }
  }, []);
  useEffect(() => {
    if (!params.spaceId) return;
    try {
      localStorage.setItem(LAST_SPACE_KEY, params.spaceId);
    } catch {
      // Not remembering is fine.
    }
  }, [params.spaceId]);

  const id = params.spaceId ?? remembered;
  const space = spaces?.find((s) => s.id === id) ?? spaces?.[0];
  return { space, isPending };
}

/** Recent jobs; polls fast while any is still on its way to the chain. */
export function useRecentJobs() {
  const memdot = useMemDot();
  return useQuery({
    queryKey: ["jobs", "recent"],
    queryFn: () => memdot.jobs.list({ limit: RECENT_JOBS }),
    refetchInterval: (query) =>
      query.state.data?.items.some((job) => !TERMINAL.has(job.status))
        ? ACTIVE_POLL_MS
        : IDLE_POLL_MS,
  });
}

export function useUsage() {
  const memdot = useMemDot();
  return useQuery({ queryKey: ["usage"], queryFn: () => memdot.usage() });
}
