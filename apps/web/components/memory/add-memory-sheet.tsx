"use client";

import type { AddResult, Namespace } from "@memdot/sdk";
import { Button } from "@memdot/ui/components/button";
import { Input } from "@memdot/ui/components/input";
import { Label } from "@memdot/ui/components/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@memdot/ui/components/sheet";
import { Spinner } from "@memdot/ui/components/spinner";
import { Switch } from "@memdot/ui/components/switch";
import { Textarea } from "@memdot/ui/components/textarea";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { EyeOffIcon, LockIcon } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { toast } from "sonner";
import { useUploads } from "@/components/files/uploads";
import { describeError } from "@/lib/errors";
import { useMemDot } from "@/lib/memdot";
import { useSpaces } from "@/lib/queries";

/** A date in the input's format, or nothing. */
const asIsoDate = (value: string) => (value ? value : undefined);

function parseMetadata(text: string): Record<string, unknown> | undefined {
  if (!text.trim()) return undefined;
  const parsed = JSON.parse(text) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Metadata must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

export function AddMemorySheet({
  namespace,
  open,
  onOpenChange,
  onAdded,
}: {
  namespace: Namespace;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdded?: (result: AddResult) => void;
}) {
  const memdot = useMemDot();
  const queryClient = useQueryClient();
  const { wallet } = useUploads();
  const { data: spaces } = useSpaces();
  const id = useId();
  const [text, setText] = useState("");
  const [userId, setUserId] = useState("me");
  const [agentId, setAgentId] = useState("");
  const [runId, setRunId] = useState("");
  const [metadata, setMetadata] = useState("");
  const [expires, setExpires] = useState("");
  const [infer, setInfer] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<AddResult | null>(null);

  const isPrivate = namespace.mode === "private";
  const privateModel = useQuery({
    queryKey: ["private-model"],
    enabled: isPrivate && open,
    queryFn: () => memdot.memories.privateModel(),
  });
  const serverModel = useQuery({
    queryKey: ["configure"],
    enabled: !isPrivate && open,
    queryFn: () => memdot.memories.configuration(),
  });
  const space = spaces?.find((row) => row.id === namespace.spaceId);
  const walletNeeded = isPrivate && space?.mode === "self_signed" && !wallet;
  // Without a model there's nothing to distill with, so the text is kept as written.
  const noPrivateModel = isPrivate && privateModel.isSuccess && privateModel.data === null;
  const noServerModel = !isPrivate && serverModel.data?.llm.source === "none";
  const noModel = noPrivateModel || noServerModel;
  const willInfer = infer && !noModel;

  const submit = async () => {
    setBusy(true);
    setResult(null);
    try {
      const added = await memdot.memories.add(text.trim(), {
        namespaceId: namespace.id,
        infer: willInfer,
        ...(userId.trim() ? { userId: userId.trim() } : {}),
        ...(agentId.trim() ? { agentId: agentId.trim() } : {}),
        ...(runId.trim() ? { runId: runId.trim() } : {}),
        ...(asIsoDate(expires) ? { expirationDate: expires } : {}),
        ...(parseMetadata(metadata) ? { metadata: parseMetadata(metadata) as object } : {}),
        ...(wallet ? { wallet } : {}),
        source: { label: "dashboard" },
      } as never);
      setResult(added);
      setText("");
      onAdded?.(added);
      await queryClient.invalidateQueries({ queryKey: ["memories", namespace.id] });
      await queryClient.invalidateQueries({ queryKey: ["namespaces"] });
      await queryClient.invalidateQueries({ queryKey: ["jobs"] });
    } catch (error) {
      toast.error(describeError(error).title);
    } finally {
      setBusy(false);
    }
  };

  const scoped = Boolean(userId.trim() || agentId.trim() || runId.trim());
  // The wait ended before the write did: not the same as there being nothing to remember.
  const stillReading = result?.results.length === 0 && result.status !== "SUCCEEDED";
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Add memory</SheetTitle>
          <SheetDescription>
            To {namespace.name ?? "this namespace"}. It's searchable in seconds and on chain soon
            after.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-4 pb-4 [&>*]:shrink-0">
          {result && (
            <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
              <span className="eyebrow">
                {stillReading
                  ? "Still reading"
                  : result.results.length === 0
                    ? "Nothing new"
                    : `Remembered ${result.results.length}`}
              </span>
              {result.results.length === 0 && (
                <p className="text-ui-sm text-text-3">
                  {stillReading
                    ? "The model is busy, so this is taking longer than usual. It'll appear in the list when it's done."
                    : result.duplicates > 0
                      ? "That's already known, so nothing was added."
                      : "Nothing in that looked worth keeping. Turn off the model to store it as written."}
                </p>
              )}
              <ul className="flex flex-col gap-1.5 text-ui-sm">
                {result.results.map((memory) => (
                  <li key={memory.id}>{memory.memory}</li>
                ))}
              </ul>
              {result.note && <p className="text-ui-sm text-warn-fg">{result.note}</p>}
            </div>
          )}
          <p className="flex items-start gap-2 rounded-lg border border-border bg-surface-1 p-3 text-ui-sm text-text-2">
            {isPrivate ? (
              <LockIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            ) : (
              <EyeOffIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            )}
            {isPrivate
              ? "This stays on your device: it's sealed here, and only the model you chose reads it."
              : "MemDot's server reads this text to extract memories, and doesn't store it in the clear."}
          </p>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-text`}>What to remember</Label>
            <Textarea
              id={`${id}-text`}
              rows={5}
              autoFocus
              value={text}
              placeholder="Priya leads payments at Flutterwave and prefers pnpm."
              onChange={(event) => setText(event.target.value)}
            />
          </div>
          <div className="flex items-start justify-between gap-4 rounded-lg border border-border p-3">
            <span className="flex flex-col gap-0.5">
              <Label htmlFor={`${id}-infer`}>Distill facts with a model</Label>
              <span className="text-ui-sm text-text-3">
                {noModel ? (
                  <>
                    No model is set, so this is stored as written.{" "}
                    <Link href="/configuration" className="underline underline-offset-2">
                      Set one
                    </Link>
                  </>
                ) : infer ? (
                  "Pulls out the facts worth keeping."
                ) : (
                  "Stores your text exactly as written."
                )}
              </span>
            </span>
            <Switch
              id={`${id}-infer`}
              checked={willInfer}
              disabled={noModel}
              onCheckedChange={setInfer}
            />
          </div>
          <div className="grid grid-cols-3 gap-2">
            {(
              [
                ["user", "User", userId, setUserId],
                ["agent", "Agent", agentId, setAgentId],
                ["run", "Run", runId, setRunId],
              ] as const
            ).map(([key, label, value, set]) => (
              <div key={key} className="flex min-w-0 flex-col gap-1.5">
                <Label htmlFor={`${id}-${key}`}>{label}</Label>
                <Input
                  id={`${id}-${key}`}
                  value={value}
                  className="font-mono"
                  onChange={(event) => set(event.target.value.replace(/\s/g, ""))}
                />
              </div>
            ))}
            <p className="col-span-3 text-ui-sm text-text-3">
              Who this is about. Searches can filter by these. At least one is needed.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-expires`}>Forget after (optional)</Label>
            <Input
              id={`${id}-expires`}
              type="date"
              value={expires}
              onChange={(event) => setExpires(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-metadata`}>Metadata (optional JSON)</Label>
            <Textarea
              id={`${id}-metadata`}
              rows={2}
              className="font-mono"
              value={metadata}
              placeholder='{"channel": "support"}'
              onChange={(event) => setMetadata(event.target.value)}
            />
            {!isPrivate && (
              <p className="text-ui-sm text-text-3">
                Scopes and metadata stay readable to the server, so they can be filtered. Keep
                secrets out of them.
              </p>
            )}
          </div>
          {walletNeeded && (
            <p className="rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-ui-sm text-warn-fg">
              This space is paid for by your wallet. Choose one in Files first.
            </p>
          )}
        </div>
        <SheetFooter className="border-t border-border">
          <Button disabled={busy || !text.trim() || !scoped || walletNeeded} onClick={submit}>
            {busy && <Spinner data-icon="inline-start" />}
            {busy ? (willInfer ? "Reading it…" : "Storing…") : "Remember"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
