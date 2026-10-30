"use client";

import { addressOf, toBytes } from "@memdot/chain";
import type { Grant, ListedFile, Space } from "@memdot/sdk";
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
import { middleEllipsis } from "@memdot/ui/components/cid-text";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@memdot/ui/components/dialog";
import { Identicon } from "@memdot/ui/components/identicon";
import { Label } from "@memdot/ui/components/label";
import { SegmentedControl } from "@memdot/ui/components/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@memdot/ui/components/select";
import { Spinner } from "@memdot/ui/components/spinner";
import { Status, StatusIndicator, StatusLabel } from "@memdot/ui/components/status";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { toast } from "sonner";
import { describeError } from "@/lib/errors";
import { formatRelative } from "@/lib/format";
import { useMemDot } from "@/lib/memdot";
import { AddressInput, accountIdOf } from "./address-input";

const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRY = [
  { value: "1", label: "1 day" },
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "never", label: "No expiry" },
];
const SCOPES = [
  { value: "read", label: "Can open" },
  { value: "read_write", label: "Can open and add" },
];

export type ShareTarget =
  | { kind: "space"; space: Space }
  | { kind: "file"; file: ListedFile; space: Space };

const GRANT_STATUS: Record<
  Grant["status"],
  { variant: "ok" | "warn" | "default" | "danger"; label: string }
> = {
  active: { variant: "ok", label: "Active" },
  pending: { variant: "warn", label: "Waiting for them" },
  expired: { variant: "default", label: "Expired" },
  revoked: { variant: "danger", label: "Revoked" },
};

/**
 * Share a space or one file with a Substrate or EVM account. Keys are wrapped on this device; a
 * recipient without MemDot yet gets a pending grant. Below: who has access, with revoke.
 * The layout follows uvain/share-file-dialog (21st.dev): invite on top, the access list beneath.
 */
export function ShareDialog({
  target,
  onOpenChange,
}: {
  target: ShareTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  const memdot = useMemDot();
  const queryClient = useQueryClient();
  const addressId = useId();
  const [address, setAddress] = useState("");
  const [scope, setScope] = useState<Grant["scope"]>("read");
  const [expiry, setExpiry] = useState("never");
  const [revoking, setRevoking] = useState<Grant | null>(null);
  const spaceId = target?.space.id;
  const objectId = target?.kind === "file" ? target.file.id : null;
  const tinyFile = target?.kind === "file" && target.file.segmentId !== null;

  const grants = useQuery({
    queryKey: ["grants", "given", spaceId],
    enabled: Boolean(spaceId),
    queryFn: () => memdot.sharing.list("given", spaceId),
  });
  const people = (grants.data?.items ?? []).filter(
    (g) =>
      g.status !== "revoked" && (objectId ? g.objectId === objectId || g.objectId === null : true),
  );

  const share = useMutation({
    mutationFn: async () => {
      if (!target) throw new Error("Nothing to share");
      const options = {
        scope,
        ...(expiry !== "never"
          ? { expiresAt: new Date(Date.now() + Number(expiry) * DAY_MS).toISOString() }
          : {}),
      };
      const to = { address: address.trim() };
      return target.kind === "file"
        ? memdot.sharing.shareFile(target.file.id, to, options)
        : memdot.sharing.shareSpace(target.space.id, to, options);
    },
    onSuccess: async (grant) => {
      toast.success(
        grant.status === "pending"
          ? "Shared. It completes when they set up MemDot and you next unlock."
          : "Shared. Their key is wrapped and stored on Portaldot.",
      );
      setAddress("");
      await queryClient.invalidateQueries({ queryKey: ["grants"] });
    },
    onError: (error) => toast.error(describeError(error).title),
  });

  const revoke = useMutation({
    mutationFn: (grant: Grant) => memdot.sharing.revoke(grant.id),
    onSuccess: async (result) => {
      toast.success(`Access revoked. New files use key epoch ${result.spaceKeyEpoch}.`);
      setRevoking(null);
      await queryClient.invalidateQueries({ queryKey: ["grants"] });
      await queryClient.invalidateQueries({ queryKey: ["spaces"] });
    },
    onError: (error) => toast.error(describeError(error).title),
  });

  const title =
    target?.kind === "file"
      ? `Share ${target.file.name ?? "file"}`
      : `Share ${target?.space.name ?? "space"}`;

  return (
    <>
      <Dialog open={target !== null} onOpenChange={onOpenChange}>
        <DialogContent className="gap-0 p-0 sm:max-w-lg">
          <DialogHeader className="p-5 pb-4">
            <DialogTitle className="text-h2">{title}</DialogTitle>
            <DialogDescription>
              {target?.kind === "file"
                ? "Only this file. Its key is re-sealed to them; the stored bytes do not change."
                : "Every file in this space, and new ones until you revoke."}
            </DialogDescription>
          </DialogHeader>

          {tinyFile ? (
            <div className="flex flex-col gap-3 border-t border-border p-5">
              <p className="text-ui-sm text-text-2">
                Files under 64 KB are packed with others into one encrypted segment, so they are
                shared with their space.
              </p>
              <Button
                variant="outline"
                className="w-fit"
                onClick={() => target && onOpenChange(false)}
              >
                Close
              </Button>
            </div>
          ) : (
            <form
              className="flex flex-col gap-4 border-t border-border p-5"
              onSubmit={(event) => {
                event.preventDefault();
                share.mutate();
              }}
            >
              <div className="flex flex-col gap-2">
                <Label htmlFor={addressId}>Recipient</Label>
                <AddressInput id={addressId} value={address} onChange={setAddress} />
              </div>
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex flex-col gap-2">
                  <span className="text-ui font-medium">Access</span>
                  <SegmentedControl
                    label="Access"
                    options={SCOPES}
                    value={scope}
                    onValueChange={(v) => setScope(v as Grant["scope"])}
                  />
                </div>
                <div className="flex min-w-36 flex-col gap-2">
                  <span className="text-ui font-medium">Expires</span>
                  <Select value={expiry} onValueChange={setExpiry}>
                    <SelectTrigger className="w-full" aria-label="Expires">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {EXPIRY.map((e) => (
                        <SelectItem key={e.value} value={e.value}>
                          {e.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  type="submit"
                  className="ml-auto"
                  disabled={share.isPending || accountIdOf(address) === null}
                >
                  {share.isPending && <Spinner data-icon="inline-start" />}
                  Grant access
                </Button>
              </div>
            </form>
          )}

          <div className="flex flex-col border-t border-border">
            <h3 className="eyebrow px-5 pt-4 pb-2">People with access</h3>
            {people.length === 0 ? (
              <p className="px-5 pb-5 text-ui-sm text-text-3">Only you.</p>
            ) : (
              <ul className="max-h-64 overflow-y-auto pb-2">
                {people.map((grant) => {
                  const accountBytes =
                    grant.granteeKind === "account" ? toBytes(grant.grantee) : null;
                  const label =
                    grant.granteeKind === "account"
                      ? middleEllipsis(addressOf(grant.grantee), 6, 6)
                      : "Agent";
                  const status = GRANT_STATUS[grant.status];
                  return (
                    <li key={grant.id} className="flex items-center gap-3 px-5 py-2">
                      {accountBytes ? (
                        <Identicon publicKey={accountBytes} size={28} />
                      ) : (
                        <span className="size-7 rounded-full bg-surface-3" />
                      )}
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate font-mono text-mono">{label}</span>
                        <span className="text-ui-sm text-text-3">
                          {grant.objectId ? "This file" : "Whole space"} ·{" "}
                          {grant.scope === "read" ? "can open" : "can open and add"}
                          {grant.expiresAt ? ` · expires ${formatRelative(grant.expiresAt)}` : ""}
                        </span>
                      </span>
                      <Status variant={status.variant}>
                        <StatusIndicator />
                        <StatusLabel>{status.label}</StatusLabel>
                      </Status>
                      <Button variant="ghost" size="sm" onClick={() => setRevoking(grant)}>
                        Revoke
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={revoking !== null} onOpenChange={(open) => !open && setRevoking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Revoke access for{" "}
              {revoking?.granteeKind === "account"
                ? middleEllipsis(addressOf(revoking.grantee), 4, 4)
                : "this agent"}
              ?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This stops future access and moves the space to a new key, so files you add next are
              sealed with a key they never get. Anything they already opened may have been kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={revoke.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (revoking) revoke.mutate(revoking);
              }}
            >
              {revoke.isPending && <Spinner data-icon="inline-start" />}
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
