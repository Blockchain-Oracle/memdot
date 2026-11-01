"use client";

import { type BrowserWallet, formatTpot, type MemDot } from "@memdot/sdk";
import { Button } from "@memdot/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { WalletPicker } from "@/components/auth/wallet-picker";
import { useMemDot } from "@/lib/memdot";

const BALANCE_REFRESH_MS = 30_000;

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-6)}`;

/** The wallet's spendable tPOT, read over this browser's own connection to Portaldot V3. */
export function useWalletBalance(wallet: BrowserWallet | null) {
  const memdot = useMemDot();
  return useQuery({
    queryKey: ["wallet-balance", wallet?.address],
    enabled: wallet !== null,
    refetchInterval: BALANCE_REFRESH_MS,
    queryFn: async () => {
      const { api } = await memdot.chain();
      const account = await api.query.System.Account.getValue(wallet?.address as string);
      return account.data.free;
    },
  });
}

/**
 * MemDot only lets an account with a linked wallet use self-signed writes, so a passkey account
 * links the first wallet it pays with. One approval prompt, and only that first time.
 */
export async function linkWalletIfNone(memdot: MemDot, wallet: BrowserWallet): Promise<void> {
  const me = await memdot.account.me();
  if (me.signIn.wallets.length === 0) await memdot.account.signInWithWallet(wallet);
}

/** The wallet that signs a self-signed space's stores: pick one, or see the chosen one's funds. */
export function SigningWallet({
  wallet,
  onChange,
  needs,
}: {
  wallet: BrowserWallet | null;
  onChange: (wallet: BrowserWallet | null) => void;
  /** What the next store costs, to warn before the wallet is asked to sign. */
  needs?: bigint;
}) {
  const { data: free } = useWalletBalance(wallet);

  if (!wallet) {
    return (
      <div className="flex flex-col gap-2">
        <span className="eyebrow">Wallet that pays</span>
        <WalletPicker
          onWallet={async (chosen) => {
            onChange(chosen);
          }}
        />
        <p className="text-ui-sm text-text-3">
          MetaMask can't sign a Portaldot store, so it isn't listed.
        </p>
      </div>
    );
  }

  const shortOfFunds = free !== undefined && needs !== undefined && free < needs;
  return (
    <div className="flex flex-col gap-2">
      <span className="eyebrow">Wallet that pays</span>
      <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface-1 px-3 py-2.5">
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-ui">{wallet.name ?? "Wallet"}</span>
          <span className="font-mono text-ui-sm text-text-3 tabular">
            {short(wallet.address)}
            {free !== undefined && ` · ${formatTpot(free)}`}
          </span>
        </span>
        <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)}>
          Change
        </Button>
      </div>
      {shortOfFunds && (
        <p className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-ui-sm text-danger-fg">
          This wallet holds {formatTpot(free)}, and this store needs about {formatTpot(needs)}.
        </p>
      )}
    </div>
  );
}
