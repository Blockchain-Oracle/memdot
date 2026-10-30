"use client";

import type { Owner, UnlockWrap } from "@memdot/sdk";
import { BrandLoader } from "@memdot/ui/components/brand";
import { Button } from "@memdot/ui/components/button";
import { RecoveryCodeGrid } from "@memdot/ui/components/recovery-code-grid";
import { Spinner } from "@memdot/ui/components/spinner";
import { useQueryClient } from "@tanstack/react-query";
import { KeyRoundIcon, RotateCcwIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { WalletPicker } from "@/components/auth/wallet-picker";
import { setAuthFlow, useAuthFlow } from "@/lib/auth-flow";
import { describeError, isCancelled } from "@/lib/errors";
import { useMemDot } from "@/lib/memdot";
import { ME_KEY, useMe } from "@/lib/session";
import { StepFrame } from "./step-frame";

type Phase =
  | { kind: "reconnect"; evm: boolean }
  | { kind: "passkey" }
  | { kind: "creating"; wallet?: string }
  | { kind: "code"; code: string; quickUnlock: boolean; offerPasskey: boolean }
  | { kind: "error"; message: string };

/**
 * Step 2: the master key is made on this device and wrapped to the recovery code and to the
 * sign-in method (passkey PRF or wallet signVrf); the code is shown once.
 */
export function StepSecure({ onDone }: { onDone: () => void }) {
  const memdot = useMemDot();
  const queryClient = useQueryClient();
  const { data: me } = useMe();
  const flow = useAuthFlow();
  const [phase, setPhase] = useState<Phase | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [adding, setAdding] = useState(false);
  const started = useRef(false);

  const create = useCallback(
    async (owner: Owner | undefined, unlock: UnlockWrap[], walletName?: string) => {
      setPhase({ kind: "creating", wallet: walletName });
      try {
        const { recoveryCode } = await memdot.account.setUp({ owner, unlock });
        setAuthFlow({ unlock: null });
        await queryClient.invalidateQueries({ queryKey: ME_KEY });
        setPhase({
          kind: "code",
          code: recoveryCode,
          quickUnlock: unlock.length > 0,
          // A passkey without PRF on this device would not unlock either; wallets may add one.
          offerPasskey: owner !== undefined && unlock.length === 0,
        });
      } catch (error) {
        setPhase({ kind: "error", message: describeError(error).title });
      }
    },
    [memdot, queryClient],
  );

  const start = useCallback(async () => {
    if (flow.wallet) {
      const wallet = flow.wallet;
      setPhase({ kind: "creating", wallet: wallet.name ?? "your wallet" });
      const vrf = await wallet.vrfSecret().catch(() => null);
      await create(
        { kind: "substrate", wallet },
        vrf ? [{ kind: "vrf", id: wallet.address, secret: vrf }] : [],
        wallet.name ?? "your wallet",
      );
    } else if (flow.evm) {
      await create({ kind: "evm", wallet: flow.evm }, [], "your wallet");
    } else if (flow.method === "passkey") {
      await create(undefined, flow.unlock ? [flow.unlock] : []);
    } else {
      // Reloaded mid-setup: the owner wallet or passkey secret has to come back first.
      const wallets = me?.signIn.wallets ?? [];
      if (wallets.length > 0) setPhase({ kind: "reconnect", evm: wallets[0]?.kind === "evm" });
      else setPhase({ kind: "passkey" });
    }
  }, [create, flow, me]);

  useEffect(() => {
    if (started.current || !me) return;
    started.current = true;
    void start();
  }, [me, start]);

  if (!phase || phase.kind === "creating") {
    return (
      <div className="flex flex-col items-center gap-3 py-16 text-center">
        <BrandLoader label="Creating your key on this device" />
        {phase?.kind === "creating" && phase.wallet && (
          <p className="text-ui-sm text-text-3">Approve the requests in {phase.wallet}.</p>
        )}
      </div>
    );
  }

  if (phase.kind === "reconnect") {
    return (
      <StepFrame
        title="Reconnect your wallet"
        description="It owns your account on chain, so it signs once more to finish setup."
      >
        <WalletPicker
          onWallet={async (wallet) => {
            setAuthFlow({ wallet });
            const vrf = await wallet.vrfSecret().catch(() => null);
            await create(
              { kind: "substrate", wallet },
              vrf ? [{ kind: "vrf", id: wallet.address, secret: vrf }] : [],
              wallet.name,
            );
          }}
          onEvm={phase.evm ? (wallet) => create({ kind: "evm", wallet }, []) : undefined}
        />
      </StepFrame>
    );
  }

  if (phase.kind === "passkey") {
    return (
      <StepFrame
        title="Secure your key"
        description="Touch your passkey once more so it can unlock your key on this device."
        actions={
          <>
            <Button
              size="lg"
              onClick={async () => {
                try {
                  const unlock = await memdot.account.passkeyUnlockWrap();
                  await create(undefined, unlock ? [unlock] : []);
                } catch (error) {
                  if (!isCancelled(error)) toast.error(describeError(error).title);
                }
              }}
            >
              <KeyRoundIcon data-icon="inline-start" />
              Continue with passkey
            </Button>
            <Button variant="ghost" size="lg" onClick={() => create(undefined, [])}>
              Use the recovery code only
            </Button>
          </>
        }
      />
    );
  }

  if (phase.kind === "error") {
    return (
      <StepFrame
        title="Your key was not created"
        description={phase.message}
        actions={
          <Button
            size="lg"
            onClick={() => {
              started.current = true;
              void start();
            }}
          >
            <RotateCcwIcon data-icon="inline-start" />
            Try again
          </Button>
        }
      />
    );
  }

  return (
    <StepFrame
      title="Save your recovery code"
      description={
        phase.quickUnlock
          ? "Your key was made on this device and stored on Portaldot, encrypted. These 12 words open it anywhere."
          : "Your key was made on this device and stored on Portaldot, encrypted. This device cannot unlock with your sign-in alone, so these 12 words are how you unlock it."
      }
      actions={
        <Button size="lg" disabled={!acknowledged} onClick={onDone}>
          Continue
        </Button>
      }
    >
      <RecoveryCodeGrid
        code={phase.code}
        acknowledged={acknowledged}
        onAcknowledgedChange={setAcknowledged}
      />
      {phase.offerPasskey && !phase.quickUnlock && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface-1 p-3">
          <p className="text-ui-sm text-text-2">Unlock with one touch next time: add a passkey.</p>
          <Button
            variant="outline"
            size="sm"
            disabled={adding}
            onClick={async () => {
              setAdding(true);
              try {
                const { prf } = await memdot.account.addPasskey();
                if (prf) {
                  toast.success("Passkey added. It unlocks your key on this device.");
                  setPhase({ ...phase, quickUnlock: true });
                } else {
                  toast.info("Passkey added for sign-in. This authenticator cannot unlock.");
                }
              } catch (error) {
                if (!isCancelled(error)) toast.error(describeError(error).title);
              } finally {
                setAdding(false);
              }
            }}
          >
            {adding && <Spinner data-icon="inline-start" />}
            Add passkey
          </Button>
        </div>
      )}
    </StepFrame>
  );
}
