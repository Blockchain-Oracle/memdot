"use client";

import { useEffect, useState } from "react";
import { useMemDot } from "./memdot";

export interface ChainHead {
  block: number | null;
  status: "connecting" | "live" | "down";
}

/** No finalized block for this long means the node stopped answering (blocks are ~6 s). */
const STALE_MS = 45_000;

/**
 * The latest finalized block, followed over this browser's own connection to Portaldot V3 (the
 * same one Verify uses), never through MemDot's API.
 */
export function useChainHead(): ChainHead {
  const memdot = useMemDot();
  const [head, setHead] = useState<ChainHead>({ block: null, status: "connecting" });

  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    let stale: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      clearTimeout(stale);
      stale = setTimeout(() => setHead((h) => ({ ...h, status: "down" })), STALE_MS);
    };
    arm();
    void memdot
      .chain()
      .then(({ client }) => {
        if (cancelled) return;
        const subscription = client.finalizedBlock$.subscribe({
          next: (block) => {
            arm();
            setHead({ block: block.number, status: "live" });
          },
          error: () => setHead((h) => ({ ...h, status: "down" })),
        });
        unsubscribe = () => subscription.unsubscribe();
      })
      .catch(() => setHead((h) => ({ ...h, status: "down" })));
    return () => {
      cancelled = true;
      clearTimeout(stale);
      unsubscribe?.();
    };
  }, [memdot]);

  return head;
}
