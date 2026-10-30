"use client";

import { cn } from "@memdot/ui/lib/utils";
import { CircleCheckIcon, CircleXIcon, LoaderCircleIcon } from "lucide-react";

/** A labelled fact row on a proof page. */
export function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 border-b border-border px-4 py-3 last:border-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <span className="eyebrow">{label}</span>
      <span className="min-w-0 text-ui text-foreground sm:text-right">{children}</span>
    </div>
  );
}

export function Facts({ children }: { children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface-1">{children}</div>
  );
}

/** One independent check run in this browser against a Portaldot node. */
export function Check({
  state,
  label,
  detail,
}: {
  state: "running" | "ok" | "failed";
  label: string;
  detail?: string;
}) {
  return (
    <li className="flex items-start gap-2.5 px-4 py-3">
      {state === "running" ? (
        <LoaderCircleIcon className="mt-0.5 size-4 shrink-0 animate-spin text-text-3" />
      ) : state === "ok" ? (
        <CircleCheckIcon className="mt-0.5 size-4 shrink-0 text-ok" />
      ) : (
        <CircleXIcon className="mt-0.5 size-4 shrink-0 text-danger" />
      )}
      <span className="flex flex-col gap-0.5">
        <span className={cn("text-ui", state === "failed" && "text-danger-fg")}>{label}</span>
        {detail && <span className="font-mono text-ui-sm break-all text-text-3">{detail}</span>}
      </span>
    </li>
  );
}

export function Checks({ children }: { children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-h3">Checked by your browser</h2>
      <p className="text-ui-sm text-text-3">
        These checks talk to a Portaldot node directly, not to MemDot.
      </p>
      <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface-1">
        {children}
      </ul>
    </section>
  );
}
