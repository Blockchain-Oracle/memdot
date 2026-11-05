"use client";

import { useChat } from "@ai-sdk/react";
import type { MemDot, Namespace } from "@memdot/sdk";
import { Button } from "@memdot/ui/components/button";
import { Skeleton } from "@memdot/ui/components/skeleton";
import { Spinner } from "@memdot/ui/components/spinner";
import { Textarea } from "@memdot/ui/components/textarea";
import { cn } from "@memdot/ui/lib/utils";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type ChatTransport,
  convertToModelMessages,
  DefaultChatTransport,
  type UIMessage,
} from "ai";
import { SendIcon, SparklesIcon, SquareIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/files/file-dialogs";
import { useUploads } from "@/components/files/uploads";
import { API_URL } from "@/lib/env";
import { describeError } from "@/lib/errors";
import { useMemDot } from "@/lib/memdot";
import { ModelError } from "./model-error";
import { ProposalCard, ProposalDiff, type ProposalState } from "./proposal-diff";
import { Reply } from "./reply";

const STARTERS = [
  "Is anything here out of date or said twice?",
  "What do you know about the people in here?",
  "Suggest better instructions for what this namespace keeps.",
];
const STEP_LABELS: Record<string, string> = {
  search_memories: "Searched memories",
  list_memories: "Read the newest memories",
  read_settings: "Read the settings",
  count_categories: "Counted categories",
};

interface ToolPart {
  type: string;
  toolCallId: string;
  state: string;
  input?: unknown;
  output?: unknown;
}

interface CardProps<Proposal> {
  namespace: Namespace;
  proposal: Proposal;
  state: ProposalState;
  onState: (state: ProposalState) => void;
  refresh: () => Promise<void>;
}

const fail = (error: unknown) => toast.error(describeError(error).title);

/** A model named this id, so it has to prove it's in the namespace being talked about. */
function ownMemory(memdot: MemDot, namespace: Namespace, id: string) {
  return {
    // Apart from the memory lists, so it isn't read again once it's changed or gone: the card keeps
    // showing what was proposed.
    queryKey: ["copilot-proposal", namespace.id, id],
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async () => {
      const memory = await memdot.memories.get(id);
      if (memory.namespaceId !== namespace.id) throw new Error("Not in this namespace.");
      return memory;
    },
  };
}

function CorrectionCard({
  namespace,
  proposal,
  state,
  onState,
  refresh,
}: CardProps<{ id: string; text: string; reason: string }>) {
  const memdot = useMemDot();
  const { wallet } = useUploads();
  const memory = useQuery(ownMemory(memdot, namespace, proposal.id));
  const apply = useMutation({
    mutationFn: () =>
      memdot.memories.update(proposal.id, { text: proposal.text }, wallet ? { wallet } : {}),
    onSuccess: async () => {
      onState("applied");
      await refresh();
    },
    onError: fail,
  });
  return (
    <ProposalCard
      title="Correct a memory"
      reason={proposal.reason}
      state={state}
      busy={apply.isPending || memory.isPending}
      blocked={memory.error ? "That memory isn't in this namespace." : null}
      onApply={() => apply.mutate()}
      onDismiss={() => onState("dismissed")}
    >
      {memory.data ? (
        <ProposalDiff before={memory.data.memory} after={proposal.text} />
      ) : memory.isPending ? (
        <Skeleton className="h-10 w-full" />
      ) : null}
    </ProposalCard>
  );
}

function ForgetCard({
  namespace,
  proposal,
  state,
  onState,
  refresh,
}: CardProps<{ ids: string[]; reason: string }>) {
  const memdot = useMemDot();
  const [confirming, setConfirming] = useState(false);
  const count = proposal.ids.length;
  const memories = useQueries({
    queries: proposal.ids.map((id) => ownMemory(memdot, namespace, id)),
  });
  return (
    <ProposalCard
      title={`Forget ${count} ${count === 1 ? "memory" : "memories"}`}
      reason={proposal.reason}
      state={state}
      action="Forget"
      busy={memories.some((memory) => memory.isPending)}
      blocked={
        memories.some((memory) => memory.error)
          ? "One of these isn't in this namespace, so this can't be applied."
          : null
      }
      onApply={() => setConfirming(true)}
      onDismiss={() => onState("dismissed")}
    >
      <ul className="flex flex-col gap-1">
        {memories.map((memory, index) =>
          memory.isPending ? (
            <Skeleton key={proposal.ids[index]} className="h-5 w-full" />
          ) : (
            <li key={proposal.ids[index]} className="text-ui-sm text-text-2 line-through">
              {memory.data?.memory ?? "A memory that isn't in this namespace"}
            </li>
          ),
        )}
      </ul>
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Forget ${count} ${count === 1 ? "memory" : "memories"}?`}
        description="They leave search and lists at once. Anything already read can't be recalled."
        action="Forget"
        onConfirm={async () => {
          await memdot.memories.batchDelete(proposal.ids);
          onState("applied");
          await refresh();
        }}
      />
    </ProposalCard>
  );
}

function SettingsCard({
  namespace,
  proposal,
  state,
  onState,
  refresh,
}: CardProps<{
  custom_instructions?: string;
  categories?: { name: string; description?: string }[];
  reason: string;
}>) {
  const memdot = useMemDot();
  const settings = useQuery({
    queryKey: ["namespace-settings", namespace.id],
    queryFn: () => memdot.memories.settings(namespace.id),
  });
  const apply = useMutation({
    mutationFn: () =>
      memdot.memories.setSettings(namespace.id, {
        customInstructions:
          proposal.custom_instructions ?? settings.data?.customInstructions ?? null,
        categories: proposal.categories ?? settings.data?.categories ?? null,
      }),
    onSuccess: async () => {
      onState("applied");
      await refresh();
    },
    onError: fail,
  });
  return (
    <ProposalCard
      title="Change the settings"
      reason={proposal.reason}
      state={state}
      busy={apply.isPending || settings.isPending}
      onApply={() => apply.mutate()}
      onDismiss={() => onState("dismissed")}
    >
      {proposal.custom_instructions !== undefined && (
        <div className="flex flex-col gap-1">
          <span className="eyebrow">Custom instructions</span>
          <ProposalDiff
            before={settings.data?.customInstructions ?? ""}
            after={proposal.custom_instructions}
          />
        </div>
      )}
      {proposal.categories && (
        <div className="flex flex-col gap-1">
          <span className="eyebrow">Categories</span>
          <ProposalDiff
            before={(settings.data?.categories ?? []).map((c) => c.name).join(", ")}
            after={proposal.categories.map((c) => c.name).join(", ")}
          />
        </div>
      )}
    </ProposalCard>
  );
}

/** An assistant over one namespace. It reads and it proposes, and only a click here changes anything. */
export function Copilot({ namespace }: { namespace: Namespace }) {
  const memdot = useMemDot();
  const queryClient = useQueryClient();
  const scroller = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState("");
  const [cards, setCards] = useState<Record<string, ProposalState>>({});

  const transport = useMemo<ChatTransport<UIMessage>>(() => {
    if (namespace.mode === "assisted") {
      return new DefaultChatTransport({
        api: `${API_URL}/v1/copilot`,
        credentials: "include",
        body: { namespace_id: namespace.id },
      });
    }
    // Private runs right here. Memories and the model's answers never touch the server.
    return {
      sendMessages: async ({ messages, abortSignal }) => {
        const result = await memdot.memories.privateCopilot(
          namespace.id,
          await convertToModelMessages(messages),
          abortSignal,
        );
        return result.toUIMessageStream({ onError: (error) => describeError(error).title });
      },
      reconnectToStream: async () => null,
    };
  }, [memdot, namespace.id, namespace.mode]);

  const { messages, sendMessage, status, stop, error } = useChat({ transport });
  const busy = status === "submitted" || status === "streaming";

  // biome-ignore lint/correctness/useExhaustiveDependencies: follows the conversation as it grows
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages]);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["memories", namespace.id] });
    await queryClient.invalidateQueries({ queryKey: ["namespace-settings", namespace.id] });
    await queryClient.invalidateQueries({ queryKey: ["entities", namespace.id] });
    await queryClient.invalidateQueries({ queryKey: ["namespaces"] });
  };
  const send = (text: string) => {
    if (!text.trim() || busy) return;
    setDraft("");
    void sendMessage({ text: text.trim() });
  };

  const card = (part: ToolPart) => {
    const shared = {
      namespace,
      refresh,
      state: cards[part.toolCallId] ?? ("open" as const),
      onState: (next: ProposalState) => setCards((all) => ({ ...all, [part.toolCallId]: next })),
    };
    if (part.type === "tool-propose_correction") {
      return (
        <CorrectionCard
          {...shared}
          proposal={part.output as { id: string; text: string; reason: string }}
        />
      );
    }
    if (part.type === "tool-propose_forget") {
      return <ForgetCard {...shared} proposal={part.output as { ids: string[]; reason: string }} />;
    }
    return (
      <SettingsCard
        {...shared}
        proposal={
          part.output as {
            custom_instructions?: string;
            categories?: { name: string; description?: string }[];
            reason: string;
          }
        }
      />
    );
  };

  return (
    <section className="flex h-[72dvh] min-h-[440px] min-w-0 flex-col rounded-xl border border-border bg-surface-1">
      <div ref={scroller} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        {messages.length === 0 && (
          <div className="m-auto flex max-w-lg flex-col items-center gap-3 text-center">
            <SparklesIcon className="size-5 text-text-3" aria-hidden="true" />
            <p className="text-ui text-text-2">
              {namespace.mode === "private"
                ? "Ask about this namespace. Your model answers here in this tab. It can read and suggest, and only you can change anything."
                : "Ask about this namespace. It can read and suggest, and only you can change anything."}
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {STARTERS.map((starter) => (
                <Button
                  key={starter}
                  variant="outline"
                  size="sm"
                  className="h-auto max-w-full py-1.5 whitespace-normal"
                  onClick={() => send(starter)}
                >
                  {starter}
                </Button>
              ))}
            </div>
          </div>
        )}
        {messages.map((message) => (
          <div
            key={message.id}
            className={cn(
              "flex min-w-0 flex-col gap-2",
              message.role === "user" ? "max-w-[85%] self-end" : "w-full",
            )}
          >
            {message.parts.map((raw, index) => {
              const part = raw as unknown as ToolPart & { text?: string };
              const key = `${message.id}:${index}`;
              if (part.type === "text") {
                return message.role === "user" ? (
                  <p
                    key={key}
                    className="rounded-xl bg-surface-2 px-3 py-2 text-ui whitespace-pre-wrap"
                  >
                    {part.text}
                  </p>
                ) : (
                  <Reply key={key}>{part.text ?? ""}</Reply>
                );
              }
              if (!part.type.startsWith("tool-")) return null;
              const name = part.type.slice("tool-".length);
              if (name.startsWith("propose_")) {
                return part.state === "output-available" ? (
                  <div key={part.toolCallId}>{card(part)}</div>
                ) : (
                  <Skeleton key={part.toolCallId} className="h-24 w-full rounded-xl" />
                );
              }
              return (
                <span
                  key={part.toolCallId}
                  className="flex items-center gap-1.5 text-ui-sm text-text-3"
                >
                  {part.state !== "output-available" && part.state !== "output-error" && (
                    <Spinner className="size-3" />
                  )}
                  {STEP_LABELS[name] ?? name}
                  {part.state === "output-error" && ", which failed"}
                </span>
              );
            })}
          </div>
        ))}
        {status === "submitted" && <Spinner aria-label="Thinking" />}
        {error && <ModelError error={error} />}
      </div>
      <form
        className="flex items-end gap-2 border-t border-border p-3"
        onSubmit={(event) => {
          event.preventDefault();
          send(draft);
        }}
      >
        <Textarea
          rows={1}
          value={draft}
          aria-label="Message"
          placeholder="Ask about these memories…"
          className="max-h-32 min-h-9 resize-none"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send(draft);
            }
          }}
        />
        {busy ? (
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Stop"
            onClick={() => void stop()}
          >
            <SquareIcon />
          </Button>
        ) : (
          <Button type="submit" size="icon" aria-label="Send" disabled={!draft.trim()}>
            <SendIcon />
          </Button>
        )}
      </form>
    </section>
  );
}
