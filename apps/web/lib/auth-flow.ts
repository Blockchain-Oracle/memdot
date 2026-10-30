"use client";

import type { BrowserWallet, EvmWallet, UnlockWrap } from "@memdot/sdk";
import { useSyncExternalStore } from "react";

/**
 * What a sign-in hands to setup in this tab: the wallet that will own the account, or the passkey
 * secret to wrap the key to. Memory only; a reload asks again.
 */
export interface AuthFlow {
  /** How this tab signed in; null after a reload. */
  method: "passkey" | "wallet" | "evm" | null;
  wallet: BrowserWallet | null;
  evm: EvmWallet | null;
  unlock: UnlockWrap | null;
}

let state: AuthFlow = { method: null, wallet: null, evm: null, unlock: null };
const listeners = new Set<() => void>();

export function setAuthFlow(next: Partial<AuthFlow>): void {
  state = { ...state, ...next };
  for (const listener of listeners) listener();
}

export function clearAuthFlow(): void {
  setAuthFlow({ method: null, wallet: null, evm: null, unlock: null });
}

export function useAuthFlow(): AuthFlow {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => state,
    () => state,
  );
}
