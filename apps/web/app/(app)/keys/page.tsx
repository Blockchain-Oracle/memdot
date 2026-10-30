"use client";

import type { ApiKey } from "@memdot/sdk";
import { Badge } from "@memdot/ui/components/badge";
import { Button } from "@memdot/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@memdot/ui/components/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@memdot/ui/components/empty";
import { Input } from "@memdot/ui/components/input";
import { Label } from "@memdot/ui/components/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@memdot/ui/components/select";
import { Skeleton } from "@memdot/ui/components/skeleton";
import { Spinner } from "@memdot/ui/components/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@memdot/ui/components/tooltip";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRoundIcon, PlusIcon } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/files/file-dialogs";
import { KeyReveal } from "@/components/keys/key-reveal";
import { ROLES, RoleChoice } from "@/components/keys/role-choice";
import { Page, PageHeader } from "@/components/page-header";
import { describeError } from "@/lib/errors";
import { formatDualTime, formatRelative } from "@/lib/format";
import { useMemDot } from "@/lib/memdot";
import { useSpaces } from "@/lib/queries";

const NAME_MAX = 64;
const EXPIRES = [
  { value: "never", label: "Never" },
  { value: "30", label: "In 30 days" },
  { value: "90", label: "In 90 days" },
];
const GROUPS: { title: string; description: string; roles: ApiKey["role"][] }[] = [
  {
    title: "App and server keys",
    description: "For code that stores and reads data. Unlock with the recovery code to decrypt.",
    roles: ["read_write", "read_only"],
  },
  {
    title: "Management keys",
    description: "Also mint keys and manage agents and grants. Keep them out of apps.",
    roles: ["management"],
  },
];

export default function KeysPage() {
  return (
    <Suspense>
      <Keys />
    </Suspense>
  );
}

function Keys() {
  const memdot = useMemDot();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const keys = useQuery({ queryKey: ["keys"], queryFn: () => memdot.keys.list() });
  const { data: spaces } = useSpaces();
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<{ secret: string; title: string } | null>(null);
  const [rotating, setRotating] = useState<ApiKey | null>(null);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);

  useEffect(() => {
    if (params.get("new") !== "1") return;
    setCreating(true);
    router.replace(pathname);
  }, [params, pathname, router]);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["keys"] });
  const spaceLabel = (key: ApiKey) =>
    !key.spaceIds
      ? "All spaces"
      : key.spaceIds.length === 1
        ? (spaces?.find((s) => s.id === key.spaceIds?.[0])?.name ?? "1 space")
        : `${key.spaceIds.length} spaces`;

  return (
    <Page>
      <PageHeader
        title="API keys"
        description="For servers, scripts and agents. MemDot keeps only a hash; each key is shown once."
        actions={
          <Button onClick={() => setCreating(true)}>
            <PlusIcon data-icon="inline-start" /> Create key
          </Button>
        }
      />

      {keys.isPending ? (
        <Skeleton className="h-40 w-full rounded-xl" />
      ) : keys.isError ? (
        <p className="rounded-xl border border-danger/30 bg-danger/10 p-4 text-ui-sm text-danger-fg">
          {describeError(keys.error).title}
        </p>
      ) : (
        GROUPS.map((group) => {
          const items = keys.data.items.filter((k) => group.roles.includes(k.role));
          return (
            <section key={group.title} className="flex flex-col gap-3">
              <div className="flex flex-col gap-0.5">
                <h2 className="text-h3">{group.title}</h2>
                <p className="text-ui-sm text-text-3">{group.description}</p>
              </div>
              {items.length === 0 ? (
                <Empty className="rounded-xl border border-dashed border-border-strong py-8">
                  <EmptyHeader>
                    <EmptyTitle className="text-ui">
                      No {group.roles.includes("management") ? "management" : ""} keys yet
                    </EmptyTitle>
                    <EmptyDescription className="font-mono text-ui-sm">
                      MEMDOT_API_KEY=md_…
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-border bg-surface-1">
                  <table className="w-full min-w-[720px] text-left">
                    <thead>
                      <tr className="border-b border-border font-mono text-label text-text-3 uppercase">
                        <th className="px-4 py-2.5 font-medium">Name</th>
                        <th className="px-4 py-2.5 font-medium">Key</th>
                        <th className="px-4 py-2.5 font-medium">Role</th>
                        <th className="px-4 py-2.5 font-medium">Spaces</th>
                        <th className="px-4 py-2.5 font-medium">Created</th>
                        <th className="px-4 py-2.5 font-medium">Last used</th>
                        <th className="px-4 py-2.5" />
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((key) => {
                        const created = formatDualTime(key.createdAt);
                        return (
                          <tr key={key.id} className="border-b border-border last:border-0">
                            <td className="px-4 py-2.5 text-ui">
                              <span className="flex items-center gap-2">
                                <KeyRoundIcon className="size-4 text-text-3" aria-hidden="true" />
                                {key.name ?? "Unnamed"}
                              </span>
                            </td>
                            <td className="px-4 py-2.5 font-mono text-mono text-text-2">
                              {key.start ?? "md_"}…
                            </td>
                            <td className="px-4 py-2.5">
                              <Badge variant="outline" className="font-normal">
                                {ROLES.find((r) => r.value === key.role)?.title ?? key.role}
                              </Badge>
                            </td>
                            <td className="px-4 py-2.5 text-ui-sm text-text-2">
                              {spaceLabel(key)}
                            </td>
                            <td className="px-4 py-2.5 text-ui-sm text-text-3">
                              <Tooltip>
                                <TooltipTrigger>{formatRelative(key.createdAt)}</TooltipTrigger>
                                <TooltipContent className="font-mono text-[12px]">
                                  {created.local} · {created.utc}
                                </TooltipContent>
                              </Tooltip>
                            </td>
                            <td className="px-4 py-2.5 text-ui-sm text-text-3">
                              {key.lastUsedAt ? formatRelative(key.lastUsedAt) : "Never"}
                              {key.expiresAt && (
                                <span className="block text-text-4">
                                  expires {formatRelative(key.expiresAt)}
                                </span>
                              )}
                            </td>
                            <td className="px-4 py-2.5 text-right whitespace-nowrap">
                              <Button variant="ghost" size="sm" onClick={() => setRotating(key)}>
                                Rotate
                              </Button>
                              <Button
                                variant="ghost"
                                size="sm"
                                className="text-danger-fg"
                                onClick={() => setRevoking(key)}
                              >
                                Revoke
                              </Button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          );
        })
      )}

      <CreateKeyDialog
        open={creating}
        onOpenChange={setCreating}
        onCreated={async (secret) => {
          setRevealed({ secret, title: "Your new API key" });
          await refresh();
        }}
      />
      <Dialog open={revealed !== null} onOpenChange={(open) => !open && setRevealed(null)}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{revealed?.title}</DialogTitle>
            <DialogDescription>Copy it now. You will not see it again.</DialogDescription>
          </DialogHeader>
          {revealed && <KeyReveal secret={revealed.secret} spaceId={spaces?.[0]?.id} />}
          <DialogFooter>
            <Button onClick={() => setRevealed(null)}>I've copied it</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={rotating !== null}
        onOpenChange={(open) => !open && setRotating(null)}
        title={`Rotate ${rotating?.name ?? "this key"}?`}
        description="The old key stops working at once. A new key with the same name, role and spaces is shown once."
        action="Rotate key"
        onConfirm={async () => {
          if (!rotating) return;
          const next = await memdot.keys.rotate(rotating.id);
          setRevealed({ secret: next.key, title: `New key for ${next.name ?? "this key"}` });
          await refresh();
        }}
      />
      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={`Revoke ${revoking?.name ?? "this key"}?`}
        description="Apps and agents using this key stop working immediately. This cannot be undone."
        action="Revoke key"
        onConfirm={async () => {
          if (!revoking) return;
          await memdot.keys.revoke(revoking.id);
          toast.success("Key revoked.");
          await refresh();
        }}
      />
    </Page>
  );
}

function CreateKeyDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (secret: string) => Promise<void>;
}) {
  const memdot = useMemDot();
  const { data: spaces } = useSpaces();
  const nameId = useId();
  const [name, setName] = useState("");
  const [role, setRole] = useState<ApiKey["role"]>("read_write");
  const [scope, setScope] = useState("all");
  const [expires, setExpires] = useState("never");

  const create = useMutation({
    mutationFn: () =>
      memdot.keys.create({
        name: name.trim(),
        role,
        spaceIds: scope === "all" ? null : [scope],
        ...(expires !== "never" ? { expiresInDays: Number(expires) } : {}),
      }),
    onSuccess: async (key) => {
      onOpenChange(false);
      setName("");
      await onCreated(key.key);
    },
    onError: (error) => toast.error(describeError(error).title),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>Create an API key</DialogTitle>
            <DialogDescription>
              Name it after where it runs, so the activity log reads well.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor={nameId}>Name</Label>
            <Input
              id={nameId}
              value={name}
              required
              maxLength={NAME_MAX}
              placeholder="prod-server"
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-ui font-medium">Role</span>
            <RoleChoice value={role} onChange={setRole} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <span className="text-ui font-medium">Spaces</span>
              <Select value={scope} onValueChange={setScope}>
                <SelectTrigger className="w-full" aria-label="Spaces">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All spaces</SelectItem>
                  {spaces?.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name ?? "Encrypted space"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-ui font-medium">Expires</span>
              <Select value={expires} onValueChange={setExpires}>
                <SelectTrigger className="w-full" aria-label="Expires">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXPIRES.map((e) => (
                    <SelectItem key={e.value} value={e.value}>
                      {e.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={create.isPending || !name.trim()}>
              {create.isPending && <Spinner data-icon="inline-start" />}
              Create key
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
