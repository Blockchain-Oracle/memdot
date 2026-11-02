"use client";

import type { MemoryMode } from "@memdot/sdk";
import { Button } from "@memdot/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@memdot/ui/components/dialog";
import { Input } from "@memdot/ui/components/input";
import { Label } from "@memdot/ui/components/label";
import { Spinner } from "@memdot/ui/components/spinner";
import { cn } from "@memdot/ui/lib/utils";
import { useQueryClient } from "@tanstack/react-query";
import { EyeOffIcon, LockIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { toast } from "sonner";
import { describeError } from "@/lib/errors";
import { useMemDot } from "@/lib/memdot";
import { useCurrentSpace } from "@/lib/queries";
import { MODE_COPY } from "./mode-badge";

const NAME_MAX = 64;
const MODES: { mode: MemoryMode; icon: typeof LockIcon }[] = [
  { mode: "assisted", icon: EyeOffIcon },
  { mode: "private", icon: LockIcon },
];

/** A namespace's mode is fixed at creation, so the choice is spelled out here (D2, P3). */
export function NewNamespaceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const memdot = useMemDot();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { space } = useCurrentSpace();
  const id = useId();
  const [name, setName] = useState("");
  const [mode, setMode] = useState<MemoryMode>("assisted");
  const [busy, setBusy] = useState(false);
  // MemDot stores Assisted segments itself, and it can't sign with someone's wallet.
  const assistedAllowed = space?.mode === "sponsored";
  const chosen = assistedAllowed ? mode : "private";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form
          className="flex flex-col gap-5"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!space) return;
            setBusy(true);
            try {
              const created = await memdot.memories.createNamespace({
                spaceId: space.id,
                name: name.trim(),
                mode: chosen,
              });
              await queryClient.invalidateQueries({ queryKey: ["namespaces"] });
              await queryClient.invalidateQueries({ queryKey: ["folders", space.id] });
              onOpenChange(false);
              setName("");
              router.push(`/memory/${created.id}`);
            } catch (error) {
              toast.error(describeError(error).title);
            } finally {
              setBusy(false);
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>New namespace</DialogTitle>
            <DialogDescription>
              A home for one app's or agent's memories, in {space?.name ?? "this space"}.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={id}>Name</Label>
            <Input
              id={id}
              required
              autoFocus
              maxLength={NAME_MAX}
              value={name}
              placeholder="Support bot"
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1.5 text-ui font-medium">Who reads the text</legend>
            {MODES.map(({ mode: option, icon: Icon }) => {
              const disabled = option === "assisted" && !assistedAllowed;
              const copy = MODE_COPY[option];
              return (
                <button
                  key={option}
                  type="button"
                  disabled={disabled}
                  aria-pressed={chosen === option}
                  onClick={() => setMode(option)}
                  className={cn(
                    "flex items-start gap-3 rounded-xl border p-3 text-left transition-colors",
                    chosen === option
                      ? "border-foreground bg-surface-2"
                      : "border-border hover:bg-surface-1",
                    disabled && "cursor-not-allowed opacity-50",
                  )}
                >
                  <Icon className="mt-0.5 size-4 shrink-0 text-text-2" aria-hidden="true" />
                  <span className="flex flex-col gap-0.5">
                    <span className="text-ui font-medium">{copy.label}</span>
                    <span className="text-ui-sm text-text-3">
                      {disabled
                        ? "Needs a space MemDot pays for, because the server stores these itself."
                        : copy.long}
                    </span>
                  </span>
                </button>
              );
            })}
            <p className="text-ui-sm text-text-3">
              This can't change later. To switch, make a new namespace and import into it.
            </p>
          </fieldset>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim() || !space}>
              {busy && <Spinner data-icon="inline-start" />} Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
