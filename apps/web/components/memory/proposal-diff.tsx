"use client";

import { Button } from "@memdot/ui/components/button";
import { Spinner } from "@memdot/ui/components/spinner";
import { Status, StatusIndicator, StatusLabel } from "@memdot/ui/components/status";
import { diffWords } from "diff";

/** A change shown in place: what goes struck through, what comes marked. */
export function ProposalDiff({ before, after }: { before: string; after: string }) {
  return (
    <p className="text-ui break-words whitespace-pre-wrap">
      {diffWords(before, after).map((part, index) => {
        const key = index; // a diff's parts never reorder
        if (part.added) {
          return (
            <ins key={key} className="rounded-sm bg-ok/15 text-ok-fg no-underline">
              {part.value}
            </ins>
          );
        }
        if (part.removed) {
          return (
            <del key={key} className="rounded-sm bg-danger/10 text-danger-fg">
              {part.value}
            </del>
          );
        }
        return <span key={key}>{part.value}</span>;
      })}
    </p>
  );
}

export type ProposalState = "open" | "applied" | "dismissed";

/** Something a model suggested. Nothing happens until the person presses Apply. */
export function ProposalCard({
  title,
  reason,
  state,
  busy,
  blocked,
  action = "Apply",
  onApply,
  onDismiss,
  children,
}: {
  title: string;
  reason: string;
  state: ProposalState;
  busy?: boolean;
  /** Why it can't be applied. */
  blocked?: string | null;
  action?: string;
  onApply: () => void;
  onDismiss: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-surface-1 p-4">
      <div className="flex flex-col gap-0.5">
        <span className="eyebrow">{title}</span>
        <p className="text-ui-sm text-text-3">{reason}</p>
      </div>
      {children}
      {blocked && state === "open" && <p className="text-ui-sm text-danger-fg">{blocked}</p>}
      {state === "open" ? (
        <div className="flex gap-2">
          <Button size="sm" disabled={busy || Boolean(blocked)} onClick={onApply}>
            {busy && <Spinner data-icon="inline-start" />} {action}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={onDismiss}>
            Dismiss
          </Button>
        </div>
      ) : (
        <Status variant={state === "applied" ? "ok" : "default"} className="self-start">
          <StatusIndicator />
          <StatusLabel>{state === "applied" ? "Applied" : "Dismissed"}</StatusLabel>
        </Status>
      )}
    </div>
  );
}
