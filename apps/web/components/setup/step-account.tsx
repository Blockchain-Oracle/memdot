"use client";

import { passkeysSupported } from "@memdot/sdk";
import { Button } from "@memdot/ui/components/button";
import { Input } from "@memdot/ui/components/input";
import { Label } from "@memdot/ui/components/label";
import { Spinner } from "@memdot/ui/components/spinner";
import { useQueryClient } from "@tanstack/react-query";
import { KeyRoundIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { OrDivider } from "@/components/auth/auth-frame";
import { WalletPicker } from "@/components/auth/wallet-picker";
import { setAuthFlow } from "@/lib/auth-flow";
import { describeError, isCancelled } from "@/lib/errors";
import { useMemDot } from "@/lib/memdot";
import { ME_KEY } from "@/lib/session";
import { StepFrame } from "./step-frame";

const NAME_MAX = 64;

/** Step 1: a passkey (default) or a wallet creates the sign-in. Existing accounts go to unlock. */
export function StepAccount({ onDone }: { onDone: () => void }) {
  const memdot = useMemDot();
  const router = useRouter();
  const queryClient = useQueryClient();
  const nameId = useId();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [supported, setSupported] = useState(true);
  useEffect(() => setSupported(passkeysSupported()), []);

  /** A wallet that already owns an account signs in instead of creating one. */
  const continueAfterSignIn = async () => {
    const me = await memdot.account.me();
    await queryClient.invalidateQueries({ queryKey: ME_KEY });
    if (me.account?.keyBundleCid) router.replace("/unlock");
    else onDone();
  };

  const withPasskey = async () => {
    setBusy(true);
    try {
      const { unlock } = await memdot.account.signUpWithPasskey({ name: name.trim() || undefined });
      setAuthFlow({ method: "passkey", unlock, wallet: null, evm: null });
      if (!unlock) {
        toast.info(
          "This passkey signs you in. It cannot unlock on this device, so keep your recovery code close.",
        );
      }
      await queryClient.invalidateQueries({ queryKey: ME_KEY });
      onDone();
    } catch (error) {
      if (!isCancelled(error)) toast.error(describeError(error).title);
    } finally {
      setBusy(false);
    }
  };

  return (
    <StepFrame
      title="Create your account"
      description="A passkey signs you in and unlocks your key in one touch. No email, no password."
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor={nameId}>
          Name <span className="font-normal text-text-3">(optional)</span>
        </Label>
        <Input
          id={nameId}
          value={name}
          maxLength={NAME_MAX}
          autoComplete="nickname"
          placeholder="How MemDot greets you"
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <Button size="lg" className="h-10 w-full" onClick={withPasskey} disabled={busy || !supported}>
        {busy ? <Spinner data-icon="inline-start" /> : <KeyRoundIcon data-icon="inline-start" />}
        Create with passkey
      </Button>
      {!supported && (
        <p className="-mt-3 text-ui-sm text-text-3">
          No passkey support in this browser. Use a wallet.
        </p>
      )}
      <OrDivider>or use a wallet</OrDivider>
      <WalletPicker
        disabled={busy}
        onWallet={async (wallet) => {
          await memdot.account.signInWithWallet(wallet, { name: name.trim() || undefined });
          setAuthFlow({ method: "wallet", wallet, evm: null, unlock: null });
          await continueAfterSignIn();
        }}
        onEvm={async (wallet) => {
          await memdot.account.signInWithEvm(wallet);
          setAuthFlow({ method: "evm", evm: wallet, wallet: null, unlock: null });
          await continueAfterSignIn();
        }}
      />
      <p className="text-center text-ui-sm text-text-3">
        Already have an account?{" "}
        <Link href="/sign-in" className="text-foreground underline-offset-4 hover:underline">
          Sign in
        </Link>
      </p>
    </StepFrame>
  );
}
