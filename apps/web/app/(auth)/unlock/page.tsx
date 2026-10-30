"use client";

import { DEFAULT_DISPLAY_NAME } from "@memdot/config";
import type { BrowserWallet } from "@memdot/sdk";
import { Button } from "@memdot/ui/components/button";
import { Skeleton } from "@memdot/ui/components/skeleton";
import { Spinner } from "@memdot/ui/components/spinner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRoundIcon, LockKeyholeIcon, WalletIcon } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AuthFrame, OrDivider } from "@/components/auth/auth-frame";
import { RecoveryCodeInput } from "@/components/auth/recovery-code-input";
import { WalletPicker } from "@/components/auth/wallet-picker";
import { clearAuthFlow, useAuthFlow } from "@/lib/auth-flow";
import { describeError, isCancelled } from "@/lib/errors";
import { useMemDot } from "@/lib/memdot";
import { ME_KEY, safeNext, useGate } from "@/lib/session";

export default function UnlockPage() {
  return (
    <AuthFrame>
      <Suspense>
        <Unlock />
      </Suspense>
    </AuthFrame>
  );
}

const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-6)}`;

function Unlock() {
  const memdot = useMemDot();
  const router = useRouter();
  const queryClient = useQueryClient();
  const next = useSearchParams().get("next");
  const { gate, me } = useGate();
  const flow = useAuthFlow();
  const [busy, setBusy] = useState<"passkey" | "wallet" | null>(null);
  const [walletOpen, setWalletOpen] = useState(false);
  const autoTried = useRef(false);

  useEffect(() => {
    if (gate === "sign-in") router.replace("/sign-in");
    else if (gate === "setup") router.replace("/setup");
    else if (gate === "ready") {
      clearAuthFlow();
      router.replace(safeNext(next));
    }
  }, [gate, next, router]);

  const methods = useQuery({
    queryKey: ["unlock-methods"],
    queryFn: () => memdot.account.unlockMethods(),
    enabled: gate === "unlock",
  });
  const passkeys = methods.data?.filter((m) => m.kind === "passkey") ?? [];
  const vrf = methods.data?.filter((m) => m.kind === "vrf") ?? [];

  const attempt = useCallback(async (kind: "passkey" | "wallet", task: () => Promise<void>) => {
    setBusy(kind);
    try {
      await task();
    } catch (error) {
      if (!isCancelled(error)) toast.error(describeError(error).title);
    } finally {
      setBusy(null);
    }
  }, []);

  const withWallet = useCallback(
    (wallet: BrowserWallet) => attempt("wallet", () => memdot.account.unlockWithWallet(wallet)),
    [attempt, memdot],
  );

  // Just signed in with a wallet that can unlock: ask for its signVrf right away.
  useEffect(() => {
    if (autoTried.current || !flow.wallet || !methods.data) return;
    if (!methods.data.some((m) => m.kind === "vrf" && m.id === flow.wallet?.address)) return;
    autoTried.current = true;
    void withWallet(flow.wallet);
  }, [flow.wallet, methods.data, withWallet]);

  const name = me?.user.name && me.user.name !== DEFAULT_DISPLAY_NAME ? me.user.name : null;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <LockKeyholeIcon className="mb-2 size-5 text-text-3" aria-hidden="true" />
        <h1 className="text-h1">Unlock MemDot</h1>
        <p className="text-ui text-text-2">
          {name ? (
            <>
              Signed in as{" "}
              <span className="text-foreground">
                {name.startsWith("0x") || name.length > 40 ? short(name) : name}
              </span>
              .{" "}
            </>
          ) : null}
          Your key opens on this device only.
        </p>
      </div>

      {methods.isPending ? (
        <Skeleton className="h-10 w-full" />
      ) : (
        <div className="flex flex-col gap-2">
          {passkeys.length > 0 && (
            <Button
              size="lg"
              className="h-10 w-full"
              disabled={busy !== null}
              onClick={() => attempt("passkey", () => memdot.account.unlockWithPasskey())}
            >
              {busy === "passkey" ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <KeyRoundIcon data-icon="inline-start" />
              )}
              Unlock with passkey
            </Button>
          )}
          {vrf.length > 0 && !walletOpen && (
            <Button
              size="lg"
              variant={passkeys.length > 0 ? "outline" : "default"}
              className="h-10 w-full"
              disabled={busy !== null}
              onClick={() =>
                flow.wallet && vrf.some((m) => m.id === flow.wallet?.address)
                  ? withWallet(flow.wallet)
                  : setWalletOpen(true)
              }
            >
              {busy === "wallet" ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <WalletIcon data-icon="inline-start" />
              )}
              Unlock with wallet
              <span className="font-mono text-ui-sm text-text-3">
                {vrf.length === 1 && vrf[0] ? short(vrf[0].id) : ""}
              </span>
            </Button>
          )}
          {walletOpen && <WalletPicker disabled={busy !== null} onWallet={withWallet} />}
        </div>
      )}

      <OrDivider>{passkeys.length + vrf.length > 0 ? "or" : "unlock with"}</OrDivider>

      <RecoveryCodeInput
        action="Unlock with recovery code"
        onSubmit={async (code) => {
          await memdot.account.unlockWithRecoveryCode(code);
          await queryClient.invalidateQueries({ queryKey: ME_KEY });
        }}
      />

      <button
        type="button"
        className="self-center text-ui-sm text-text-3 underline-offset-4 hover:text-foreground hover:underline"
        onClick={async () => {
          await memdot.account.signOut().catch(() => undefined);
          clearAuthFlow();
          queryClient.clear();
          router.replace("/sign-in");
        }}
      >
        Sign out
      </button>
    </div>
  );
}
