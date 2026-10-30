"use client";

import { passkeysSupported } from "@memdot/sdk";
import { Button } from "@memdot/ui/components/button";
import { Spinner } from "@memdot/ui/components/spinner";
import { useQueryClient } from "@tanstack/react-query";
import { KeyRoundIcon, ShieldCheckIcon } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { toast } from "sonner";
import { AuthFrame, OrDivider } from "@/components/auth/auth-frame";
import { WalletPicker } from "@/components/auth/wallet-picker";
import { setAuthFlow } from "@/lib/auth-flow";
import { describeError, isCancelled } from "@/lib/errors";
import { useMemDot } from "@/lib/memdot";
import { ME_KEY, safeNext, useGate } from "@/lib/session";

export default function SignInPage() {
  return (
    <AuthFrame>
      <Suspense>
        <SignIn />
      </Suspense>
    </AuthFrame>
  );
}

function SignIn() {
  const memdot = useMemDot();
  const router = useRouter();
  const queryClient = useQueryClient();
  const next = useSearchParams().get("next");
  const { gate } = useGate();
  const [busy, setBusy] = useState(false);
  const [supported, setSupported] = useState(true);

  useEffect(() => setSupported(passkeysSupported()), []);
  useEffect(() => {
    if (gate === "setup") router.replace("/setup");
    else if (gate === "unlock")
      router.replace(`/unlock${next ? `?next=${encodeURIComponent(next)}` : ""}`);
    else if (gate === "ready") router.replace(safeNext(next));
  }, [gate, next, router]);

  const signedIn = () => queryClient.invalidateQueries({ queryKey: ME_KEY });

  const withPasskey = async () => {
    setBusy(true);
    try {
      const result = await memdot.account.signInWithPasskey();
      if (!result.prf) toast.info("This passkey signs you in but cannot unlock here.");
      await signedIn();
    } catch (error) {
      if (!isCancelled(error)) toast.error(describeError(error).title);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-h1">Sign in</h1>
        <p className="text-ui text-text-2">
          Your files are encrypted on this device and stored on Portaldot.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Button
          size="lg"
          className="h-10 w-full"
          onClick={withPasskey}
          disabled={busy || !supported}
        >
          {busy ? <Spinner data-icon="inline-start" /> : <KeyRoundIcon data-icon="inline-start" />}
          Continue with passkey
        </Button>
        {!supported && (
          <p className="text-ui-sm text-text-3">
            This browser has no passkey support. Use a wallet or your recovery code.
          </p>
        )}
        <Button asChild variant="ghost" className="w-full text-text-2">
          <Link href="/setup">New to MemDot? Create an account</Link>
        </Button>
      </div>

      <OrDivider>or use a wallet</OrDivider>

      <WalletPicker
        disabled={busy}
        onWallet={async (wallet) => {
          await memdot.account.signInWithWallet(wallet);
          setAuthFlow({ method: "wallet", wallet, evm: null });
          await signedIn();
        }}
        onEvm={async (wallet) => {
          await memdot.account.signInWithEvm(wallet);
          setAuthFlow({ method: "evm", evm: wallet, wallet: null });
          await signedIn();
        }}
      />

      <div className="flex flex-col items-center gap-3 pt-2">
        <Link href="/recover" className="text-ui-sm text-text-2 underline-offset-4 hover:underline">
          Lost your passkey? Use your recovery code
        </Link>
        <p className="flex items-center gap-1.5 text-ui-sm text-text-3">
          <ShieldCheckIcon className="size-3.5" aria-hidden="true" />
          Phishing-resistant. Your keys never leave this device.
        </p>
      </div>
    </div>
  );
}
