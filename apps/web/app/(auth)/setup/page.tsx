"use client";

import { BrandLoader, Wordmark } from "@memdot/ui/components/brand";
import {
  Stepper,
  StepperDescription,
  StepperIndicator,
  StepperItem,
  StepperSeparator,
  StepperTitle,
} from "@memdot/ui/components/stepper";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRightIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { StepAccount } from "@/components/setup/step-account";
import { StepApiKey } from "@/components/setup/step-api-key";
import { StepFirstFile } from "@/components/setup/step-first-file";
import { StepSecure } from "@/components/setup/step-secure";
import { StepSpace } from "@/components/setup/step-space";
import { clearAuthFlow } from "@/lib/auth-flow";
import { DOCS_URL } from "@/lib/env";
import { useMemDot, useUnlocked } from "@/lib/memdot";
import { HOME, useGate } from "@/lib/session";

const STEPS = [
  { title: "Account", description: "Passkey or wallet" },
  { title: "Recovery code", description: "Your key, on this device" },
  { title: "First space", description: "Where files live" },
  { title: "API key", description: "For servers and agents" },
  { title: "First file", description: "Stored on Portaldot" },
] as const;

export default function SetupPage() {
  const memdot = useMemDot();
  const router = useRouter();
  const unlocked = useUnlocked();
  const queryClient = useQueryClient();
  const { gate } = useGate();
  const [step, setStep] = useState<number | null>(null);
  const [spaceId, setSpaceId] = useState<string | null>(null);

  // Where a returning visitor resumes: progress is read from the account itself.
  const spaces = useQuery({
    queryKey: ["spaces"],
    queryFn: () => memdot.spaces.list(),
    enabled: gate === "ready",
  });

  useEffect(() => {
    if (step !== null || gate === "loading") return;
    if (gate === "sign-in") setStep(1);
    else if (gate === "setup") setStep(2);
    else if (gate === "unlock") router.replace("/unlock?next=/setup");
    else if (spaces.data) {
      const first = spaces.data[0];
      if (!first) setStep(3);
      else {
        setSpaceId(first.id);
        setStep(4);
      }
    }
  }, [gate, spaces.data, step, router]);

  const finish = () => router.replace(HOME);
  const signOut = async () => {
    await memdot.account.signOut().catch(() => undefined);
    clearAuthFlow();
    queryClient.clear();
    router.replace("/sign-in");
  };

  return (
    <div className="flex min-h-svh">
      <aside className="sticky top-0 hidden h-svh w-[280px] shrink-0 flex-col justify-between border-r border-border bg-surface-2 p-6 lg:flex">
        <div className="flex flex-col gap-10">
          <Link href="/" className="w-fit">
            <Wordmark />
          </Link>
          <Stepper orientation="vertical" value={step ?? 1}>
            {STEPS.map((s, i) => (
              <StepperItem
                key={s.title}
                step={i + 1}
                className="relative items-start not-last:flex-1"
              >
                <div className="flex items-start gap-3 pb-6">
                  <StepperIndicator />
                  <div className="flex flex-col gap-0.5 pt-0.5">
                    <StepperTitle>{s.title}</StepperTitle>
                    <StepperDescription>{s.description}</StepperDescription>
                  </div>
                </div>
                {i < STEPS.length - 1 && (
                  <StepperSeparator className="absolute top-7 left-3 -order-1 m-0 h-[calc(100%-2rem)]" />
                )}
              </StepperItem>
            ))}
          </Stepper>
        </div>
        <div className="flex flex-col items-start gap-2">
          <a
            href={DOCS_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-ui-sm text-text-3 hover:text-foreground"
          >
            Need help? Read the docs <ArrowUpRightIcon className="size-3.5" />
          </a>
          {gate !== "sign-in" && gate !== "loading" && (
            <button
              type="button"
              onClick={signOut}
              className="text-ui-sm text-text-3 hover:text-foreground"
            >
              Sign out
            </button>
          )}
        </div>
      </aside>

      <main className="flex flex-1 flex-col">
        <header className="flex h-14 items-center justify-between px-4 lg:hidden">
          <Wordmark />
          {step !== null && (
            <span className="eyebrow">
              Step {step} of {STEPS.length}
            </span>
          )}
        </header>
        <div className="flex flex-1 justify-center px-4 py-10 sm:items-center sm:py-16">
          <div className="w-full max-w-[480px]">
            {step === null ? (
              <BrandLoader />
            ) : (
              <>
                <p className="eyebrow mb-3 hidden lg:block">
                  Step {step} of {STEPS.length}
                </p>
                {step === 1 && <StepAccount onDone={() => setStep(2)} />}
                {step === 2 && <StepSecure onDone={() => setStep(3)} />}
                {step === 3 && unlocked && (
                  <StepSpace
                    onDone={(id) => {
                      setSpaceId(id);
                      setStep(4);
                    }}
                  />
                )}
                {step === 4 && <StepApiKey onDone={() => setStep(5)} />}
                {step === 5 && spaceId && <StepFirstFile spaceId={spaceId} onDone={finish} />}
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
