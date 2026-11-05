"use client";

import type { DreamProposal, Namespace } from "@memdot/sdk";
import { Badge } from "@memdot/ui/components/badge";
import { Button } from "@memdot/ui/components/button";
import { Checkbox } from "@memdot/ui/components/checkbox";
import { Spinner } from "@memdot/ui/components/spinner";
import { Status, StatusIndicator, StatusLabel } from "@memdot/ui/components/status";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MoonStarIcon, SparklesIcon } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/files/file-dialogs";
import { describeError } from "@/lib/errors";
import { useMemDot } from "@/lib/memdot";

const GROUPS: { kind: DreamProposal["kind"]; title: string; description: string }[] = [
  {
    kind: "supersede",
    title: "Out of date",
    description: "A newer memory replaces these. They're forgotten, and the newer one stays.",
  },
  {
    kind: "merge",
    title: "Said twice",
    description: "These say the same thing. The first takes the new wording, and the rest go.",
  },
  {
    kind: "synthesis",
    title: "Patterns",
    description: "A new memory that sums these up. They all stay.",
  },
];

/** Tidy a namespace: a model suggests, a person picks, and only then does anything change. */
export function Dream({ namespace }: { namespace: Namespace }) {
  const memdot = useMemDot();
  const queryClient = useQueryClient();
  const id = useId();
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [applied, setApplied] = useState<Set<number>>(new Set());
  const [confirming, setConfirming] = useState(false);

  const run = useMutation({
    mutationFn: () => memdot.memories.dream({ namespaceId: namespace.id }),
    onSuccess: ({ proposals }) => {
      setPicked(new Set(proposals.map((_, index) => index)));
      setApplied(new Set());
    },
    onError: (error) => toast.error(describeError(error).title),
  });
  const proposals = run.data?.proposals;
  const texts = new Map(run.data?.memories.map((memory) => [memory.id, memory.memory]));

  const sourceList = (ids: string[], struck: boolean) => (
    <ul className="flex flex-col gap-1">
      {ids.map((source) => (
        <li
          key={source}
          className={struck ? "text-ui-sm text-text-3 line-through" : "text-ui-sm text-text-2"}
        >
          {texts.get(source)}
        </li>
      ))}
    </ul>
  );

  if (!proposals) {
    return (
      <div className="flex flex-col items-start gap-4 rounded-xl border border-border bg-surface-1 p-6">
        <MoonStarIcon className="size-5 text-text-3" aria-hidden="true" />
        <div className="flex max-w-xl flex-col gap-1">
          <h2 className="text-h3">Tidy this namespace</h2>
          <p className="text-ui-sm text-text-3">
            {namespace.mode === "private"
              ? "Your model reads the newest 100 memories on this device, and suggests what's out of date, what's said twice and what's worth summing up."
              : "The server's model reads the newest 100 memories, and suggests what's out of date, what's said twice and what's worth summing up."}{" "}
            One model call. Nothing changes until you've looked at each one.
          </p>
        </div>
        <Button disabled={run.isPending} onClick={() => run.mutate()}>
          {run.isPending ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <SparklesIcon data-icon="inline-start" />
          )}
          {run.isPending ? "Reading…" : "Look for changes"}
        </Button>
      </div>
    );
  }

  if (proposals.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-xl border border-border bg-surface-1 p-6">
        <h2 className="text-h3">Nothing to tidy</h2>
        <p className="text-ui-sm text-text-3">These memories already say what they should.</p>
        <Button variant="outline" disabled={run.isPending} onClick={() => run.mutate()}>
          {run.isPending && <Spinner data-icon="inline-start" />} Look again
        </Button>
      </div>
    );
  }

  const chosen = [...picked].filter((index) => !applied.has(index));
  const apply = async () => {
    const done = new Set(applied);
    let failed = 0;
    for (const index of chosen) {
      try {
        await memdot.memories.applyDream(proposals[index] as DreamProposal);
        done.add(index);
      } catch {
        failed += 1;
      }
    }
    setApplied(done);
    await queryClient.invalidateQueries({ queryKey: ["memories", namespace.id] });
    await queryClient.invalidateQueries({ queryKey: ["namespaces"] });
    await queryClient.invalidateQueries({ queryKey: ["entities", namespace.id] });
    if (failed) toast.error(`${failed} couldn't be applied. The rest are done.`);
    else toast.success("Done. Each change is in that memory's history.");
  };

  return (
    <div className="flex flex-col gap-6">
      {GROUPS.map((group) => {
        const rows = proposals
          .map((proposal, index) => ({ proposal, index }))
          .filter(({ proposal }) => proposal.kind === group.kind);
        if (rows.length === 0) return null;
        return (
          <section key={group.kind} className="flex flex-col gap-3">
            <div className="flex flex-col gap-0.5">
              <h2 className="flex items-center gap-2 text-h3">
                {group.title} <Badge variant="outline">{rows.length}</Badge>
              </h2>
              <p className="text-ui-sm text-text-3">{group.description}</p>
            </div>
            <ul className="flex flex-col gap-2">
              {rows.map(({ proposal, index }) => (
                <li
                  key={index}
                  className="flex gap-3 rounded-xl border border-border bg-surface-1 p-4"
                >
                  {applied.has(index) ? (
                    <Status variant="ok" className="h-fit shrink-0">
                      <StatusIndicator />
                      <StatusLabel>Applied</StatusLabel>
                    </Status>
                  ) : (
                    <Checkbox
                      id={`${id}-${index}`}
                      className="mt-0.5"
                      aria-label={proposal.reason}
                      checked={picked.has(index)}
                      onCheckedChange={(on) =>
                        setPicked((all) => {
                          const next = new Set(all);
                          if (on) next.add(index);
                          else next.delete(index);
                          return next;
                        })
                      }
                    />
                  )}
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <p className="text-ui-sm text-text-3">{proposal.reason}</p>
                    {proposal.kind === "supersede" ? (
                      <>
                        {sourceList(proposal.sources, true)}
                        <p className="text-ui">{texts.get(proposal.kept as string)}</p>
                      </>
                    ) : (
                      <>
                        {sourceList(proposal.sources, proposal.kind === "merge")}
                        <p className="text-ui">{proposal.text}</p>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      <div className="sticky bottom-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface-1 p-3 shadow-overlay">
        <span className="text-ui-sm text-text-3">
          {chosen.length} of {proposals.length} selected
        </span>
        <div className="flex gap-2">
          <Button variant="ghost" disabled={run.isPending} onClick={() => run.mutate()}>
            {run.isPending && <Spinner data-icon="inline-start" />} Look again
          </Button>
          <Button disabled={chosen.length === 0} onClick={() => setConfirming(true)}>
            Apply {chosen.length}
          </Button>
        </div>
      </div>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Apply ${chosen.length} ${chosen.length === 1 ? "change" : "changes"}?`}
        description="What's replaced leaves search and lists at once. Anything already read can't be recalled."
        action="Apply"
        onConfirm={apply}
      />
    </div>
  );
}
