"use client";

import { useQueryClient } from "@tanstack/react-query";
import { LifeBuoyIcon } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { AuthFrame } from "@/components/auth/auth-frame";
import { RecoveryCodeInput } from "@/components/auth/recovery-code-input";
import { useMemDot } from "@/lib/memdot";
import { ME_KEY, safeNext } from "@/lib/session";

export default function RecoverPage() {
  return (
    <AuthFrame>
      <Suspense>
        <Recover />
      </Suspense>
    </AuthFrame>
  );
}

function Recover() {
  const memdot = useMemDot();
  const router = useRouter();
  const queryClient = useQueryClient();
  const next = useSearchParams().get("next");
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <LifeBuoyIcon className="mb-2 size-5 text-text-3" aria-hidden="true" />
        <h1 className="text-h1">Recover your account</h1>
        <p className="text-ui text-text-2">
          The recovery code signs you in and unlocks your key on this device. Add a passkey
          afterwards in Settings.
        </p>
      </div>
      <RecoveryCodeInput
        action="Sign in and unlock"
        onSubmit={async (code) => {
          await memdot.account.recover(code);
          await queryClient.invalidateQueries({ queryKey: ME_KEY });
          router.replace(safeNext(next));
        }}
      />
      <Link
        href={next ? `/sign-in?next=${encodeURIComponent(next)}` : "/sign-in"}
        className="self-center text-ui-sm text-text-3 underline-offset-4 hover:text-foreground hover:underline"
      >
        Back to sign in
      </Link>
    </div>
  );
}
