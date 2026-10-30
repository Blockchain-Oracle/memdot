"use client";

import {
  type BrowserWallet,
  connectEvmWallet,
  connectWallet,
  discoverEvmWallets,
  type EvmWallet,
  type EvmWalletInfo,
  type InjectedAccount,
  installedWallets,
  SUBSTRATE_WALLETS,
} from "@memdot/sdk";
import { Button } from "@memdot/ui/components/button";
import { Spinner } from "@memdot/ui/components/spinner";
import { cn } from "@memdot/ui/lib/utils";
import { ArrowLeftIcon, ArrowUpRightIcon, ChevronRightIcon } from "lucide-react";
import Image from "next/image";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { describeError, isCancelled } from "@/lib/errors";

const LOGO: Record<string, string> = {
  "portaldot extension": "/wallets/portaldot.png",
  talisman: "/wallets/talisman.svg",
  "subwallet-js": "/wallets/subwallet-js.svg",
  "polkadot-js": "/wallets/polkadot-js.svg",
  metamask: "/wallets/metamask.svg",
};
const METAMASK_RDNS = "io.metamask";
const METAMASK_URL = "https://metamask.io/download";
/** Extensions inject at document start, but some announce a moment later. */
const DETECT_RETRY_MS = 400;

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-6)}`;

/**
 * Talisman, SubWallet, polkadot.js, the Portaldot extension and MetaMask in one list, each with its
 * real logo and whether it is installed. Choosing a Substrate wallet with several accounts asks
 * which one.
 */
export function WalletPicker({
  onWallet,
  onEvm,
  disabled,
}: {
  onWallet: (wallet: BrowserWallet) => Promise<void>;
  onEvm?: (wallet: EvmWallet) => Promise<void>;
  disabled?: boolean;
}) {
  const [installed, setInstalled] = useState<string[]>([]);
  const [evm, setEvm] = useState<EvmWalletInfo[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [choosing, setChoosing] = useState<{
    source: string;
    accounts: InjectedAccount[];
    pick: (address: string) => BrowserWallet;
  } | null>(null);

  useEffect(() => {
    const detect = () => setInstalled(installedWallets());
    detect();
    const timer = setTimeout(detect, DETECT_RETRY_MS);
    void discoverEvmWallets().then(setEvm);
    return () => clearTimeout(timer);
  }, []);

  const run = async (id: string, task: () => Promise<void>) => {
    setBusy(id);
    try {
      await task();
    } catch (error) {
      if (!isCancelled(error)) toast.error(describeError(error).title);
    } finally {
      setBusy(null);
    }
  };

  const chooseSubstrate = (source: string) =>
    run(source, async () => {
      const { accounts, wallet } = await connectWallet(source);
      if (accounts.length === 0) {
        toast.error("No Substrate account is shared with MemDot. Allow one in the wallet.");
        return;
      }
      if (accounts.length === 1 && accounts[0]) {
        await onWallet(wallet(accounts[0].address));
        return;
      }
      setChoosing({ source, accounts, pick: wallet });
    });

  if (choosing) {
    const meta = SUBSTRATE_WALLETS.find((w) => w.id === choosing.source);
    return (
      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={() => setChoosing(null)}
          className="inline-flex w-fit items-center gap-1.5 text-ui-sm text-text-3 hover:text-foreground"
        >
          <ArrowLeftIcon className="size-3.5" /> {meta?.name ?? choosing.source} accounts
        </button>
        <ul className="flex flex-col overflow-hidden rounded-xl border border-border bg-surface-1">
          {choosing.accounts.map((account) => (
            <li key={account.address} className="border-b border-border last:border-0">
              <button
                type="button"
                disabled={disabled || busy !== null}
                onClick={() => run(account.address, () => onWallet(choosing.pick(account.address)))}
                className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-surface-2 disabled:opacity-60"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-ui">{account.name ?? "Account"}</span>
                  <span className="font-mono text-ui-sm text-text-3">{short(account.address)}</span>
                </span>
                {busy === account.address ? (
                  <Spinner />
                ) : (
                  <ChevronRightIcon className="size-4 text-text-3" />
                )}
              </button>
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const metamask = evm.find((w) => w.rdns === METAMASK_RDNS) ?? evm[0];
  const rows = [
    ...SUBSTRATE_WALLETS.map((w) => ({
      id: w.id,
      name: w.name,
      logo: LOGO[w.id],
      url: w.url,
      present: installed.includes(w.id),
      connect: () => chooseSubstrate(w.id),
    })),
    ...(onEvm
      ? [
          {
            id: "metamask",
            name: metamask && metamask.rdns !== METAMASK_RDNS ? metamask.name : "MetaMask",
            logo: metamask && metamask.rdns !== METAMASK_RDNS ? metamask.icon : LOGO.metamask,
            url: METAMASK_URL,
            present: metamask !== undefined,
            connect: () =>
              metamask && run("metamask", async () => onEvm(await connectEvmWallet(metamask))),
          },
        ]
      : []),
  ];

  return (
    <ul className="flex flex-col overflow-hidden rounded-xl border border-border bg-surface-1">
      {rows.map((row) => (
        <li key={row.id} className="border-b border-border last:border-0">
          {row.present ? (
            <button
              type="button"
              disabled={disabled || busy !== null}
              onClick={row.connect}
              className={cn(
                "group flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors duration-(--motion-instant) hover:bg-surface-2 disabled:opacity-60",
              )}
            >
              <WalletLogo src={row.logo} name={row.name} />
              <span className="flex-1 text-ui">{row.name}</span>
              {busy === row.id ? (
                <Spinner />
              ) : (
                <span className="eyebrow text-ok-fg group-hover:hidden">Detected</span>
              )}
              {busy !== row.id && (
                <ChevronRightIcon className="hidden size-4 text-text-3 group-hover:block" />
              )}
            </button>
          ) : (
            <div className="flex items-center gap-3 px-3 py-2.5">
              <WalletLogo src={row.logo} name={row.name} muted />
              <span className="flex-1 text-ui text-text-3">{row.name}</span>
              <Button asChild variant="ghost" size="sm" className="text-text-3">
                <a href={row.url} target="_blank" rel="noreferrer">
                  Install <ArrowUpRightIcon data-icon="inline-end" />
                </a>
              </Button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function WalletLogo({ src, muted }: { src?: string; name: string; muted?: boolean }) {
  if (!src) return <span className="size-7 rounded-md bg-surface-3" aria-hidden="true" />;
  return (
    <Image
      src={src}
      alt=""
      width={28}
      height={28}
      unoptimized
      className={cn("size-7 rounded-md", muted && "opacity-50 grayscale")}
    />
  );
}
