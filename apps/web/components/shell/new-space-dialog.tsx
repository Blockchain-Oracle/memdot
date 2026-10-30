"use client";

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
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { toast } from "sonner";
import { describeError } from "@/lib/errors";
import { useMemDot } from "@/lib/memdot";

const NAME_MAX = 64;

export function NewSpaceDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const memdot = useMemDot();
  const router = useRouter();
  const queryClient = useQueryClient();
  const id = useId();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form
          className="flex flex-col gap-5"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            try {
              const space = await memdot.spaces.create({ name: name.trim() });
              await queryClient.invalidateQueries({ queryKey: ["spaces"] });
              setName("");
              onOpenChange(false);
              router.push(`/spaces/${space.id}`);
            } catch (error) {
              toast.error(describeError(error).title);
            } finally {
              setBusy(false);
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>New space</DialogTitle>
            <DialogDescription>
              A space has its own key, so sharing it shares nothing else. Its name is encrypted on
              this device.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor={id}>Name</Label>
            <Input
              id={id}
              value={name}
              autoFocus
              required
              maxLength={NAME_MAX}
              placeholder="Client files"
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy && <Spinner data-icon="inline-start" />}
              Create space
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
