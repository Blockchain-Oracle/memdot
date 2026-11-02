"use client";

import { BrandMark } from "@memdot/ui/components/brand";
import { Button } from "@memdot/ui/components/button";
import { useQueryClient } from "@tanstack/react-query";
import { BotIcon, ShieldCheckIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemDot } from "@/lib/memdot";
import { hereWithQuery } from "@/lib/session";

/** The two sides of a connection, then what it's asking for. From supabase/oauth-consent-react. */
export function ConsentHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex flex-col items-center gap-4 text-center">
      <div className="flex items-center" aria-hidden="true">
        <span className="flex size-11 items-center justify-center rounded-full border border-border bg-surface-1">
          <BotIcon className="size-5 text-text-2" />
        </span>
        <span className="h-px w-8 bg-border" />
        <span className="flex size-11 items-center justify-center rounded-full border border-border bg-surface-1">
          <BrandMark className="size-5" />
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <h1 className="text-h1">{title}</h1>
        <p className="text-ui text-text-2">{description}</p>
      </div>
    </div>
  );
}

/** Label and value rows: who's asking and where the answer goes. */
export function ConsentFacts({ rows }: { rows: { label: string; value: React.ReactNode }[] }) {
  return (
    <dl className="divide-y divide-border rounded-xl border border-border bg-surface-1 text-ui-sm">
      {rows.map((row) => (
        <div key={row.label} className="flex items-center justify-between gap-6 p-3">
          <dt className="shrink-0 text-text-3">{row.label}</dt>
          <dd className="min-w-0 text-right font-medium break-words">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * Connecting an agent outlives this session, so an old sign-in isn't enough. Asked before the form
 * rather than after it, so nobody fills it in for nothing.
 */
export function ConfirmItsYou() {
  const memdot = useMemDot();
  const router = useRouter();
  const queryClient = useQueryClient();
  return (
    <div className="flex flex-col items-center gap-4 rounded-xl border border-border bg-surface-1 p-6 text-center">
      <ShieldCheckIcon className="size-6 text-text-2" aria-hidden="true" />
      <div className="flex flex-col gap-1">
        <p className="text-ui font-medium">Confirm it's you</p>
        <p className="text-ui-sm text-text-2">
          Connecting an agent gives it lasting access, so it needs a recent sign-in.
        </p>
      </div>
      <Button
        onClick={async () => {
          const next = encodeURIComponent(hereWithQuery());
          await memdot.account.signOut().catch(() => undefined);
          queryClient.clear();
          router.replace(`/sign-in?next=${next}`);
        }}
      >
        Sign in again
      </Button>
    </div>
  );
}
