"use client";

import type { Memory, Namespace, VerifyResult } from "@memdot/sdk";
import { Badge } from "@memdot/ui/components/badge";
import { Button } from "@memdot/ui/components/button";
import { CidText } from "@memdot/ui/components/cid-text";
import { JsonViewer } from "@memdot/ui/components/json-viewer";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@memdot/ui/components/sheet";
import { Skeleton } from "@memdot/ui/components/skeleton";
import { Spinner } from "@memdot/ui/components/spinner";
import { Status, StatusIndicator, StatusLabel } from "@memdot/ui/components/status";
import { Textarea } from "@memdot/ui/components/textarea";
import { Timeline, type TimelineEvent } from "@memdot/ui/components/timeline";
import { cn } from "@memdot/ui/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CircleCheckIcon,
  CircleXIcon,
  FileIcon,
  PencilIcon,
  ShieldCheckIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  TrashIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/files/file-dialogs";
import { describeError } from "@/lib/errors";
import { formatDualTime, formatRelative } from "@/lib/format";
import { useMemDot } from "@/lib/memdot";
import { ModeBadge } from "./mode-badge";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-t border-border px-5 py-4">
      <h3 className="eyebrow">{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 text-ui-sm">
      <span className="text-text-3">{label}</span>
      <span className="min-w-0 truncate text-right font-mono text-foreground">{children}</span>
    </div>
  );
}

/** What changed between two versions, word by word: common start and end, and the middle differs. */
function WordDiff({ before, after }: { before: string; after: string }) {
  const a = before.split(/(\s+)/);
  const b = after.split(/(\s+)/);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let end = 0;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  ) {
    end += 1;
  }
  return (
    <p className="text-ui-sm whitespace-pre-wrap">
      {a.slice(0, start).join("")}
      {a.length - end > start && (
        <del className="rounded-sm bg-danger/15 text-danger-fg decoration-danger/50">
          {a.slice(start, a.length - end).join("")}
        </del>
      )}
      {b.length - end > start && (
        <ins className="rounded-sm bg-ok/15 text-ok-fg no-underline">
          {b.slice(start, b.length - end).join("")}
        </ins>
      )}
      {a.slice(a.length - end).join("")}
    </p>
  );
}

const EVENT_TITLE = { ADD: "remembered this", UPDATE: "changed it", DELETE: "forgot it" } as const;

/** One memory: what it says, who it's about, where it came from, its proof on chain, its history. */
export function MemorySheet({
  memory,
  namespace,
  onOpenChange,
}: {
  memory: Memory | null;
  namespace: Namespace;
  onOpenChange: (open: boolean) => void;
}) {
  const memdot = useMemDot();
  const queryClient = useQueryClient();
  const id = memory?.id;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [confirmForget, setConfirmForget] = useState(false);
  const [verified, setVerified] = useState<VerifyResult | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a different memory starts fresh
  useEffect(() => {
    setEditing(false);
    setVerified(null);
  }, [id]);

  const detail = useQuery({
    queryKey: ["memory", id],
    enabled: Boolean(id),
    initialData: memory ?? undefined,
    queryFn: () => memdot.memories.get(id as string),
    refetchInterval: (query) =>
      query.state.data?.mode === "assisted" && query.state.data.segment?.status !== "stored"
        ? 3_000
        : false,
  });
  const current = detail.data ?? memory;
  const segmentCid = current?.segment?.cid;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new version is a new segment to verify
  useEffect(() => setVerified(null), [segmentCid]);
  const history = useQuery({
    queryKey: ["memory", id, "history"],
    enabled: Boolean(id),
    queryFn: () => memdot.memories.history(id as string),
  });
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["memories", namespace.id] });
    await queryClient.invalidateQueries({ queryKey: ["memory", id] });
    await queryClient.invalidateQueries({ queryKey: ["namespaces"] });
    await queryClient.invalidateQueries({ queryKey: ["entities"] });
  };

  const save = useMutation({
    mutationFn: () => memdot.memories.update(id as string, { text: draft.trim() }),
    onSuccess: async () => {
      setEditing(false);
      await refresh();
    },
    onError: (error) => toast.error(describeError(error).title),
  });
  const feedback = useMutation({
    mutationFn: (value: "POSITIVE" | "NEGATIVE" | null) =>
      memdot.memories.feedback(id as string, value),
    onSuccess: refresh,
    onError: (error) => toast.error(describeError(error).title),
  });
  const verify = useMutation({
    mutationFn: () => memdot.files.verify(current?.segment?.id as string),
    onSuccess: setVerified,
    onError: (error) => toast.error(describeError(error).title),
  });

  const events = useMemo<TimelineEvent[]>(
    () =>
      (history.data ?? []).map((row, index) => ({
        id: `${row.createdAt}-${index}`,
        at: row.createdAt,
        // The dashboard's client name means the person looking at this.
        actor: !row.actor ? "MemDot" : row.actor.startsWith("web/") ? "You" : row.actor,
        title: EVENT_TITLE[row.event],
        tone: row.event === "DELETE" ? ("danger" as const) : ("neutral" as const),
        ...(row.event === "UPDATE" && row.oldMemory !== null && row.newMemory !== null
          ? { detail: <WordDiff before={row.oldMemory} after={row.newMemory} /> }
          : row.newMemory
            ? { detail: <p className="text-ui-sm">{row.newMemory}</p> }
            : {}),
      })),
    [history.data],
  );

  const metadata = current?.metadata;
  const scopes = current
    ? (
        [
          ["User", current.userId],
          ["Agent", current.agentId],
          ["Run", current.runId],
        ] as const
      ).filter(([, value]) => value)
    : [];

  return (
    <Sheet open={Boolean(memory)} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            Memory <ModeBadge mode={namespace.mode} />
          </SheetTitle>
          <SheetDescription>
            {current ? `Added ${formatRelative(current.createdAt)}` : ""}
          </SheetDescription>
        </SheetHeader>
        {current && (
          <>
            <div className="flex flex-col gap-3 px-5 pb-4">
              {editing ? (
                <>
                  <Textarea
                    rows={5}
                    autoFocus
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                  />
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" size="sm" onClick={() => setEditing(false)}>
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      disabled={!draft.trim() || draft === current.memory || save.isPending}
                      onClick={() => save.mutate()}
                    >
                      {save.isPending && <Spinner data-icon="inline-start" />} Save new version
                    </Button>
                  </div>
                </>
              ) : (
                <p className="text-ui whitespace-pre-wrap">{current.memory}</p>
              )}
              {current.raw && (
                <p className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-ui-sm text-warn-fg">
                  No model read this, so it's the text as written.
                </p>
              )}
              {!editing && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={current.immutable}
                    onClick={() => {
                      setDraft(current.memory);
                      setEditing(true);
                    }}
                  >
                    <PencilIcon data-icon="inline-start" />{" "}
                    {current.immutable ? "Immutable" : "Edit"}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setConfirmForget(true)}>
                    <TrashIcon data-icon="inline-start" /> Forget
                  </Button>
                  <span className="ml-auto flex items-center gap-0.5">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Useful"
                      aria-pressed={current.feedback === "POSITIVE"}
                      className={cn(current.feedback === "POSITIVE" && "text-ok-fg")}
                      onClick={() =>
                        feedback.mutate(current.feedback === "POSITIVE" ? null : "POSITIVE")
                      }
                    >
                      <ThumbsUpIcon />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Not useful"
                      aria-pressed={current.feedback === "NEGATIVE"}
                      className={cn(current.feedback === "NEGATIVE" && "text-danger-fg")}
                      onClick={() =>
                        feedback.mutate(current.feedback === "NEGATIVE" ? null : "NEGATIVE")
                      }
                    >
                      <ThumbsDownIcon />
                    </Button>
                  </span>
                </div>
              )}
            </div>

            <Section title="About">
              {scopes.length === 0 && <p className="text-ui-sm text-text-3">No scope.</p>}
              {scopes.map(([label, value]) => (
                <Row key={label} label={label}>
                  {value}
                </Row>
              ))}
              {current.categories && current.categories.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {current.categories.map((category) => (
                    <Badge key={category} variant="outline" className="font-normal">
                      {category.replaceAll("_", " ")}
                    </Badge>
                  ))}
                </div>
              )}
              {current.expirationDate && (
                <Row label="Forgotten after">{formatDualTime(current.expirationDate).local}</Row>
              )}
              {current.attributedTo && <Row label="Came from">{current.attributedTo}</Row>}
            </Section>

            {current.source && (
              <Section title="Source">
                {current.source.objectId ? (
                  <>
                    <Link
                      href={`/spaces/${namespace.spaceId}?folder=${namespace.id}`}
                      className="flex items-center gap-2 text-ui-sm underline-offset-2 hover:underline"
                    >
                      <FileIcon className="size-3.5 text-text-3" aria-hidden="true" />
                      {current.source.label ?? "A file"}
                    </Link>
                    <p className="text-ui-sm text-text-3">
                      Deleting that file deletes this memory.
                    </p>
                  </>
                ) : (
                  <p className="text-ui-sm text-text-2">
                    {current.source.kind === "import"
                      ? `Imported from ${current.source.label ?? "another product"}`
                      : current.source.label
                        ? `Written by ${current.source.label}`
                        : "A conversation"}
                  </p>
                )}
              </Section>
            )}

            <Section title="On Portaldot">
              {current.mode === "private" ? (
                <p className="text-ui-sm text-text-3">
                  In an encrypted segment. Only this device can open it, and Restore rebuilds this
                  list from the chain.
                </p>
              ) : current.segment ? (
                <>
                  <Row label="Segment">
                    <CidText value={current.segment.cid} />
                  </Row>
                  <Row label="Status">
                    <Status variant={current.segment.status === "stored" ? "ok" : "live"}>
                      <StatusIndicator pulse={current.segment.status !== "stored"} />
                      <StatusLabel>
                        {current.segment.status === "stored" ? "Stored" : "On its way"}
                      </StatusLabel>
                    </Status>
                  </Row>
                  {current.segment.block !== null && (
                    <Row label="Block">
                      <Link
                        href={`/proof/block/${current.segment.block}`}
                        className="underline-offset-2 hover:underline"
                      >
                        #{current.segment.block.toLocaleString("en-US")}
                      </Link>
                    </Row>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={current.segment.status !== "stored" || verify.isPending}
                    onClick={() => verify.mutate()}
                  >
                    {verify.isPending ? (
                      <Spinner data-icon="inline-start" />
                    ) : (
                      <ShieldCheckIcon data-icon="inline-start" />
                    )}
                    Verify from this browser
                  </Button>
                  {verified && (
                    <p
                      className={cn(
                        "flex items-center gap-1.5 text-ui-sm",
                        verified.ok ? "text-ok-fg" : "text-danger-fg",
                      )}
                    >
                      {verified.ok ? (
                        <CircleCheckIcon className="size-3.5" aria-hidden="true" />
                      ) : (
                        <CircleXIcon className="size-3.5" aria-hidden="true" />
                      )}
                      {verified.ok
                        ? "The bytes match their hash on chain."
                        : verified.inconclusive
                          ? "A node didn't answer. Try again."
                          : "The chain doesn't match."}
                    </p>
                  )}
                  <Link
                    href={`/proof/cid/${current.segment.cid}`}
                    className="text-ui-sm text-text-3 underline-offset-2 hover:underline"
                  >
                    Public proof page
                  </Link>
                </>
              ) : (
                <p className="text-ui-sm text-text-3">Being written to the chain.</p>
              )}
            </Section>

            {metadata && Object.keys(metadata).length > 0 && (
              <Section title="Metadata">
                <JsonViewer value={metadata} />
              </Section>
            )}

            <Section title="History">
              {history.isPending ? (
                <Skeleton className="h-16 w-full" />
              ) : (
                <Timeline
                  events={events}
                  now={Date.now()}
                  label="Memory history"
                  headingLevel={4}
                />
              )}
            </Section>
          </>
        )}
      </SheetContent>
      <ConfirmDialog
        open={confirmForget}
        onOpenChange={setConfirmForget}
        title="Forget this memory?"
        description="It leaves search and lists at once. Its encrypted entry leaves the chain when its segment is rewritten or expires, and anything already read can't be recalled."
        action="Forget"
        onConfirm={async () => {
          await memdot.memories.delete(id as string);
          onOpenChange(false);
          await refresh();
        }}
      />
    </Sheet>
  );
}
