"use client";

import { SPONSORED_QUOTA_BYTES } from "@memdot/config";
import { Button } from "@memdot/ui/components/button";
import { Input } from "@memdot/ui/components/input";
import { Label } from "@memdot/ui/components/label";
import { Spinner } from "@memdot/ui/components/spinner";
import { useQueryClient } from "@tanstack/react-query";
import { LockIcon } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { describeError } from "@/lib/errors";
import { formatBytes } from "@/lib/format";
import { useMemDot } from "@/lib/memdot";
import { StepFrame } from "./step-frame";

const NAME_MAX = 64;

/** Step 3: the first space. Its name is sealed with the space's own key before it is sent. */
export function StepSpace({ onDone }: { onDone: (spaceId: string) => void }) {
  const memdot = useMemDot();
  const queryClient = useQueryClient();
  const id = useId();
  const [name, setName] = useState("Personal");
  const [busy, setBusy] = useState(false);

  return (
    <StepFrame
      title="Name your first space"
      description="A space holds files and memories. Each one has its own key, so you can share one without sharing the rest."
    >
      <form
        className="flex flex-col gap-6"
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          try {
            const space = await memdot.spaces.create({ name: name.trim() });
            await queryClient.invalidateQueries({ queryKey: ["spaces"] });
            onDone(space.id);
          } catch (error) {
            toast.error(describeError(error).title);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor={id}>Space name</Label>
          <Input
            id={id}
            value={name}
            maxLength={NAME_MAX}
            required
            onChange={(event) => setName(event.target.value)}
          />
          <p className="flex items-center gap-1.5 text-ui-sm text-text-3">
            <LockIcon className="size-3.5" aria-hidden="true" />
            Encrypted on this device. MemDot never sees the name.
          </p>
        </div>
        <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border text-ui-sm">
          <div className="bg-surface-1 p-3">
            <dt className="eyebrow">Paid by</dt>
            <dd className="mt-1 text-foreground">MemDot (sponsored)</dd>
          </div>
          <div className="bg-surface-1 p-3">
            <dt className="eyebrow">Quota</dt>
            <dd className="mt-1 font-mono text-foreground tabular">
              {formatBytes(SPONSORED_QUOTA_BYTES)}
            </dd>
          </div>
        </dl>
        <div>
          <Button type="submit" size="lg" disabled={busy || !name.trim()}>
            {busy && <Spinner data-icon="inline-start" />}
            Create space
          </Button>
        </div>
      </form>
    </StepFrame>
  );
}
