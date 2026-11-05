"use client";

import type { ChatEvent, Memory, Namespace } from "@memdot/sdk";
import { Badge } from "@memdot/ui/components/badge";
import { Button } from "@memdot/ui/components/button";
import { Input } from "@memdot/ui/components/input";
import { Label } from "@memdot/ui/components/label";
import { Skeleton } from "@memdot/ui/components/skeleton";
import { Spinner } from "@memdot/ui/components/spinner";
import { Switch } from "@memdot/ui/components/switch";
import { Textarea } from "@memdot/ui/components/textarea";
import { cn } from "@memdot/ui/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BrainIcon, RotateCcwIcon, SendIcon, SquareIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useUploads } from "@/components/files/uploads";
import { describeError } from "@/lib/errors";
import { formatRelative } from "@/lib/format";
import { useMemDot } from "@/lib/memdot";
import { MemorySheet } from "./memory-sheet";
import { ModelError } from "./model-error";
import { Reply } from "./reply";

const DEFAULT_USER = "playground";
const LIST_SIZE = 30;
const STARTERS = [
  "I'm allergic to peanuts and I live in Lisbon.",
  "My bicycle is called Zebra.",
  "What do you remember about me?",
];

type Recalled = Extract<ChatEvent, { type: "recalled" }>["memories"];

interface Turn {
  id: string;
  role: "user" | "assistant";
  content: string;
  recalled?: Recalled;
  saving?: boolean;
  saved?: number;
  error?: unknown;
}

function MemoryRow({
  memory,
  fresh,
  onOpen,
}: {
  memory: Memory;
  fresh: boolean;
  onOpen: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        className="flex w-full flex-col gap-1 rounded-md px-2 py-1.5 text-left hover:bg-surface-2"
        onClick={onOpen}
      >
        <span className="text-ui-sm">{memory.memory}</span>
        <span className="flex items-center gap-2 text-ui-sm text-text-3">
          {fresh && <Badge className="font-normal">New</Badge>}
          {formatRelative(memory.createdAt)}
        </span>
      </button>
    </li>
  );
}

/** Try a namespace: chat beside what it recalls and keeps, turn by turn. */
export function Playground({ namespace }: { namespace: Namespace }) {
  const memdot = useMemDot();
  const queryClient = useQueryClient();
  const { wallet } = useUploads();
  const id = useId();
  const [userId, setUserId] = useState(DEFAULT_USER);
  const [save, setSave] = useState(true);
  const [draft, setDraft] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<Memory | null>(null);
  const abort = useRef<AbortController | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  const person = userId.trim();
  const listKey = ["memories", namespace.id, "playground", person];
  const remembered = useQuery({
    queryKey: listKey,
    enabled: Boolean(person),
    queryFn: () =>
      memdot.memories.list({
        namespaceId: namespace.id,
        pageSize: LIST_SIZE,
        filters: { user_id: person },
      }),
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: follows the conversation as it grows
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [turns]);
  useEffect(() => () => abort.current?.abort(), []);

  const patchLast = (change: (turn: Turn) => Turn) =>
    setTurns((all) => all.map((turn, i) => (i === all.length - 1 ? change(turn) : turn)));

  const send = async (text: string) => {
    const content = text.trim();
    if (!content || busy || !person) return;
    const history = turns
      .filter((turn) => !turn.error)
      .map(({ role, content: said }) => ({ role, content: said }));
    setDraft("");
    setBusy(true);
    setTurns((all) => [
      ...all,
      { id: crypto.randomUUID(), role: "user", content },
      { id: crypto.randomUUID(), role: "assistant", content: "" },
    ]);
    const controller = new AbortController();
    abort.current = controller;
    try {
      for await (const event of memdot.memories.chat([...history, { role: "user", content }], {
        namespaceId: namespace.id,
        userId: person,
        save,
        signal: controller.signal,
        ...(wallet ? { wallet } : {}),
      })) {
        if (event.type === "recalled") {
          patchLast((turn) => ({ ...turn, recalled: event.memories }));
        } else if (event.type === "text") {
          patchLast((turn) => ({ ...turn, content: turn.content + event.text }));
        } else if (event.type === "saving") {
          patchLast((turn) => ({ ...turn, saving: true }));
        } else {
          patchLast((turn) => ({ ...turn, saving: false, saved: event.memories.length }));
          setFreshIds((known) => new Set([...known, ...event.memories.map((row) => row.id)]));
          await queryClient.invalidateQueries({ queryKey: ["memories", namespace.id] });
          await queryClient.invalidateQueries({ queryKey: ["entities", namespace.id] });
          await queryClient.invalidateQueries({ queryKey: ["namespaces"] });
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        patchLast((turn) => ({ ...turn, saving: false, error }));
      }
    } finally {
      setBusy(false);
    }
  };

  const lastRecalled = [...turns].reverse().find((turn) => turn.recalled)?.recalled;
  const memories = remembered.data?.results ?? [];

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <section className="flex h-[70dvh] min-h-[420px] min-w-0 flex-col rounded-xl border border-border bg-surface-1">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-border p-3">
          <div className="flex min-w-40 flex-1 items-center gap-2">
            <Label htmlFor={`${id}-user`} className="shrink-0 text-text-3">
              Talking as
            </Label>
            <Input
              id={`${id}-user`}
              value={userId}
              disabled={busy}
              className="font-mono"
              onChange={(event) => setUserId(event.target.value)}
            />
          </div>
          <div className="flex items-center gap-2">
            <Switch id={`${id}-save`} checked={save} disabled={busy} onCheckedChange={setSave} />
            <Label htmlFor={`${id}-save`}>Remember this chat</Label>
          </div>
          {turns.length > 0 && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Start over"
              disabled={busy}
              onClick={() => setTurns([])}
            >
              <RotateCcwIcon />
            </Button>
          )}
        </div>
        <div ref={scroller} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
          {turns.length === 0 && (
            <div className="m-auto flex max-w-md flex-col items-center gap-3 text-center">
              <BrainIcon className="size-5 text-text-3" aria-hidden="true" />
              <p className="text-ui text-text-2">
                {namespace.mode === "private"
                  ? "Your model answers here in this tab, using what this namespace remembers."
                  : "The server's model answers, using what this namespace remembers."}
              </p>
              <div className="flex flex-wrap justify-center gap-2">
                {STARTERS.map((starter) => (
                  <Button
                    key={starter}
                    variant="outline"
                    size="sm"
                    className="h-auto whitespace-normal"
                    disabled={!person}
                    onClick={() => void send(starter)}
                  >
                    {starter}
                  </Button>
                ))}
              </div>
            </div>
          )}
          {turns.map((turn, index) => (
            <div
              key={turn.id}
              className={cn(
                "flex max-w-[85%] flex-col gap-1.5",
                turn.role === "user" && "self-end",
              )}
            >
              {turn.role === "user" ? (
                <p className="rounded-xl bg-surface-2 px-3 py-2 text-ui whitespace-pre-wrap">
                  {turn.content}
                </p>
              ) : (
                <>
                  {turn.content ? (
                    <Reply>{turn.content}</Reply>
                  ) : (
                    !turn.error &&
                    busy &&
                    index === turns.length - 1 && <Spinner aria-label="Thinking" />
                  )}
                  {Boolean(turn.error) && <ModelError error={turn.error} />}
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-ui-sm text-text-3">
                    {turn.recalled && (
                      <span>
                        Used {turn.recalled.length}{" "}
                        {turn.recalled.length === 1 ? "memory" : "memories"}
                      </span>
                    )}
                    {turn.saving && (
                      <span className="flex items-center gap-1.5">
                        <Spinner className="size-3" /> Keeping what matters…
                      </span>
                    )}
                    {turn.saved !== undefined && (
                      <span>
                        {turn.saved === 0
                          ? "Nothing new to keep"
                          : `Kept ${turn.saved} new ${turn.saved === 1 ? "memory" : "memories"}`}
                      </span>
                    )}
                  </span>
                </>
              )}
            </div>
          ))}
        </div>
        <form
          className="flex items-end gap-2 border-t border-border p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void send(draft);
          }}
        >
          <Textarea
            rows={1}
            value={draft}
            aria-label="Message"
            placeholder="Say something worth remembering…"
            className="max-h-32 min-h-9 resize-none"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send(draft);
              }
            }}
          />
          {busy ? (
            <Button
              type="button"
              variant="outline"
              size="icon"
              aria-label="Stop"
              onClick={() => abort.current?.abort()}
            >
              <SquareIcon />
            </Button>
          ) : (
            <Button type="submit" size="icon" aria-label="Send" disabled={!draft.trim() || !person}>
              <SendIcon />
            </Button>
          )}
        </form>
      </section>

      <aside className="flex min-w-0 flex-col gap-4">
        {lastRecalled && (
          <section className="flex flex-col gap-2 rounded-xl border border-border bg-surface-1 p-3">
            <h2 className="eyebrow">Given to the model last turn</h2>
            {lastRecalled.length === 0 ? (
              <p className="px-2 text-ui-sm text-text-3">Nothing relevant was found.</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {lastRecalled.map((memory) => (
                  <li key={memory.id} className="flex items-baseline gap-3 px-2 py-1">
                    <span className="min-w-0 flex-1 text-ui-sm">{memory.memory}</span>
                    <span
                      className="shrink-0 font-mono text-ui-sm text-text-3 tabular"
                      title="Relevance, 0 to 1"
                    >
                      {memory.score.toFixed(2)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
        <section className="flex flex-col gap-2 rounded-xl border border-border bg-surface-1 p-3">
          <h2 className="eyebrow">Remembered about {person || "…"}</h2>
          {remembered.isPending && person ? (
            <Skeleton className="h-24 w-full" />
          ) : remembered.error ? (
            <p className="px-2 text-ui-sm text-danger-fg">
              {describeError(remembered.error).title}
            </p>
          ) : memories.length === 0 ? (
            <p className="px-2 py-4 text-ui-sm text-text-3">Nothing yet.</p>
          ) : (
            <ul className="flex max-h-[50dvh] flex-col gap-1 overflow-y-auto">
              {memories.map((memory) => (
                <MemoryRow
                  key={memory.id}
                  memory={memory}
                  fresh={freshIds.has(memory.id)}
                  onOpen={() => setOpen(memory)}
                />
              ))}
            </ul>
          )}
        </section>
      </aside>
      <MemorySheet
        memory={open}
        namespace={namespace}
        onOpenChange={(next) => !next && setOpen(null)}
      />
    </div>
  );
}
