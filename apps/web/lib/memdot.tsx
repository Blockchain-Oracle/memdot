"use client";

import { MemDot } from "@memdot/sdk";
import { createContext, useContext, useState, useSyncExternalStore } from "react";
import { API_URL, RPC_URL } from "./env";

const MemDotContext = createContext<MemDot | null>(null);

/**
 * One MemDot client per tab. Encryption happens in it and the master key lives only in its
 * memory: a reload or "Lock" forgets the key and the unlock screen asks again.
 */
export function MemDotProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(() =>
    MemDot.create({ baseUrl: API_URL, rpc: RPC_URL, client: "web/0.0.0" }),
  );
  return <MemDotContext value={client}>{children}</MemDotContext>;
}

export function useMemDot(): MemDot {
  const client = useContext(MemDotContext);
  if (!client) throw new Error("useMemDot must be used inside <MemDotProvider>");
  return client;
}

/** Whether this device holds the master key right now. */
export function useUnlocked(): boolean {
  const memdot = useMemDot();
  return useSyncExternalStore(
    (onChange) => memdot.account.onLockChange(onChange),
    () => memdot.account.unlocked,
    () => false,
  );
}
