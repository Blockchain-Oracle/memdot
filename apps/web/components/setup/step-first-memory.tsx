"use client";

import type { AddResult, Namespace, ScoredMemory } from "@memdot/sdk";
import { Button } from "@memdot/ui/components/button";
import { Label } from "@memdot/ui/components/label";
import { Spinner } from "@memdot/ui/components/spinner";
import { Textarea } from "@memdot/ui/components/textarea";
import { useQueryClient } from "@tanstack/react-query";
import { BrainIcon, SearchIcon } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { describeError } from "@/lib/errors";
import { useMemDot } from "@/lib/memdot";
import { StepFrame } from "./step-frame";

const SAMPLE = "My name is Sam. I prefer window seats and my favourite tea is Earl Grey.";
const SAMPLE_QUESTION = "What should I drink?";
const NAMESPACE_NAME = "Memory";

/** The last step: remember a fact, then ask for it back in other words. */
export function StepFirstMemory({ spaceId, onDone }: { spaceId: string; onDone: () => void }) {
  const memdot = useMemDot();
  const queryClient = useQueryClient();
  const id = useId();
  const [text, setText] = useState(SAMPLE);
  const [busy, setBusy] = useState(false);
  const [namespace, setNamespace] = useState<Namespace | null>(null);
  const [added, setAdded] = useState<AddResult | null>(null);
  const [recalled, setRecalled] = useState<ScoredMemory[] | null>(null);

  const remember = async () => {
    setBusy(true);
    try {
      const space = await memdot.spaces.get(spaceId);
      const existing = (await memdot.memories.namespaces(spaceId))[0];
      const target =
        namespace ??
        existing ??
        (await memdot.memories.createNamespace({
          spaceId,
          name: NAMESPACE_NAME,
          // MemDot stores Assisted segments itself, and it can't sign with someone's wallet.
          mode: space.mode === "sponsored" ? "assisted" : "private",
        }));
      setNamespace(target);
      setAdded(
        await memdot.memories.add(text.trim(), {
          namespaceId: target.id,
          userId: "me",
          source: { label: "setup" },
        }),
      );
      await queryClient.invalidateQueries({ queryKey: ["namespaces"] });
    } catch (error) {
      toast.error(describeError(error).title);
    } finally {
      setBusy(false);
    }
  };
  const recall = async () => {
    if (!namespace) return;
    setBusy(true);
    try {
      setRecalled(
        await memdot.memories.search(SAMPLE_QUESTION, { namespaceId: namespace.id, topK: 3 }),
      );
    } catch (error) {
      toast.error(describeError(error).title);
    } finally {
      setBusy(false);
    }
  };

  return (
    <StepFrame
      title="Remember a fact"
      description="Agents get long-term memory the same way. This one is encrypted, stored on Portaldot, and searchable by meaning."
    >
      <div className="flex flex-col gap-4">
        {!added ? (
          <>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={id}>Tell it something</Label>
              <Textarea
                id={id}
                rows={3}
                value={text}
                onChange={(event) => setText(event.target.value)}
              />
              <p className="text-ui-sm text-text-3">
                MemDot's server reads this to pull out the facts, and doesn't store it in the clear.
                For memories only your device can read, make a Private namespace later.
              </p>
            </div>
            <Button disabled={busy || !text.trim()} onClick={remember}>
              {busy ? <Spinner data-icon="inline-start" /> : <BrainIcon data-icon="inline-start" />}
              {busy ? "Reading it…" : "Remember"}
            </Button>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface-1 p-3">
              <span className="eyebrow">Remembered</span>
              <ul className="flex flex-col gap-1.5 text-ui-sm">
                {added.results.map((memory) => (
                  <li key={memory.id}>{memory.memory}</li>
                ))}
              </ul>
              {added.results.length === 0 && (
                <p className="text-ui-sm text-text-3">That was already known.</p>
              )}
              {added.note && <p className="text-ui-sm text-warn-fg">{added.note}</p>}
            </div>
            {!recalled ? (
              <Button variant="outline" disabled={busy} onClick={recall}>
                {busy ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <SearchIcon data-icon="inline-start" />
                )}
                Ask "{SAMPLE_QUESTION}"
              </Button>
            ) : (
              <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface-1 p-3">
                <span className="eyebrow">Recalled, by meaning</span>
                <ul className="flex flex-col gap-1.5 text-ui-sm">
                  {recalled.map((memory) => (
                    <li key={memory.id} className="flex justify-between gap-3">
                      <span>{memory.memory}</span>
                      <span className="font-mono text-text-3 tabular">
                        {memory.score.toFixed(2)}
                      </span>
                    </li>
                  ))}
                </ul>
                {recalled.length === 0 && (
                  <p className="text-ui-sm text-text-3">Nothing close enough yet.</p>
                )}
              </div>
            )}
          </>
        )}
        <Button variant={added ? "default" : "ghost"} onClick={onDone}>
          {added ? "Go to the dashboard" : "Skip for now"}
        </Button>
      </div>
    </StepFrame>
  );
}
