"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@memdot/ui/components/alert-dialog";
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
import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { describeError } from "@/lib/errors";

const NAME_MAX = 255;

/** A one-field dialog: new folder, rename. The value is sealed on this device before saving. */
export function NameDialog({
  open,
  onOpenChange,
  title,
  description,
  label,
  initial = "",
  action,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  label: string;
  initial?: string;
  action: string;
  onSubmit: (value: string) => Promise<void>;
}) {
  const id = useId();
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setValue(initial);
  }, [open, initial]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form
          className="flex flex-col gap-5"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            try {
              await onSubmit(value.trim());
              onOpenChange(false);
            } catch (error) {
              toast.error(describeError(error).title);
            } finally {
              setBusy(false);
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor={id}>{label}</Label>
            <Input
              id={id}
              value={value}
              autoFocus
              required
              maxLength={NAME_MAX}
              onChange={(event) => setValue(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !value.trim() || value.trim() === initial}>
              {busy && <Spinner data-icon="inline-start" />}
              {action}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A destructive confirm that names what goes. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  action,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  action: string;
  onConfirm: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={busy}
            onClick={async (event) => {
              event.preventDefault();
              setBusy(true);
              try {
                await onConfirm();
                onOpenChange(false);
              } catch (error) {
                toast.error(describeError(error).title);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy && <Spinner data-icon="inline-start" />}
            {action}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
