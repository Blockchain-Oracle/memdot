"use client";

import { SPONSORED_QUOTA_BYTES } from "@memdot/config";
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
import { SegmentedControl } from "@memdot/ui/components/segmented-control";
import { Spinner } from "@memdot/ui/components/spinner";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { toast } from "sonner";
import { linkWalletIfNone, SigningWallet } from "@/components/files/signing-wallet";
import { useUploads } from "@/components/files/uploads";
import { describeError, isCancelled } from "@/lib/errors";
import { formatBytes } from "@/lib/format";
import { useMemDot } from "@/lib/memdot";

const NAME_MAX = 64;
const PAYERS = [
  { value: "sponsored", label: "MemDot" },
  { value: "self_signed", label: "My wallet" },
];

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
  const { wallet, setWallet } = useUploads();
  const id = useId();
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"sponsored" | "self_signed">("sponsored");
  const [busy, setBusy] = useState(false);
  const selfSigned = mode === "self_signed";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form
          className="flex flex-col gap-5"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            try {
              if (selfSigned && wallet) await linkWalletIfNone(memdot, wallet);
              const space = await memdot.spaces.create({ name: name.trim(), mode });
              await queryClient.invalidateQueries({ queryKey: ["spaces"] });
              setName("");
              setMode("sponsored");
              onOpenChange(false);
              router.push(`/spaces/${space.id}`);
            } catch (error) {
              if (!isCancelled(error)) toast.error(describeError(error).title);
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
          <div className="flex flex-col gap-2">
            <span className="eyebrow">Who pays to store</span>
            <SegmentedControl
              label="Who pays to store"
              options={PAYERS}
              value={mode}
              onValueChange={(value) => setMode(value as typeof mode)}
            />
            <p className="text-ui-sm text-text-3">
              {selfSigned
                ? "Your wallet signs and pays for each store, with no quota. MemDot still renews them."
                : `MemDot signs and pays, up to ${formatBytes(SPONSORED_QUOTA_BYTES)}.`}
            </p>
          </div>
          {selfSigned && <SigningWallet wallet={wallet} onChange={setWallet} />}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim() || (selfSigned && !wallet)}>
              {busy && <Spinner data-icon="inline-start" />}
              Create space
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
