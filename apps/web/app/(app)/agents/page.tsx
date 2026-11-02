"use client";

import type { Agent } from "@memdot/sdk";
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
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@memdot/ui/components/sheet";
import { Skeleton } from "@memdot/ui/components/skeleton";
import { Spinner } from "@memdot/ui/components/spinner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BotIcon, KeyRoundIcon, PlugIcon, PlusIcon } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { toast } from "sonner";
import { ConnectInstructions } from "@/components/agents/connect-instructions";
import { ConfirmDialog } from "@/components/files/file-dialogs";
import { Page, PageHeader } from "@/components/page-header";
import { describeError } from "@/lib/errors";
import { formatRelative } from "@/lib/format";
import { useMemDot } from "@/lib/memdot";
import { useSpaces } from "@/lib/queries";

const LABEL_MAX = 64;
const ROLE_LABEL = { read_write: "Read and write", read_only: "Read only" } as const;

export default function AgentsPage() {
  return (
    <Suspense>
      <Agents />
    </Suspense>
  );
}

function Agents() {
  const memdot = useMemDot();
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [connecting, setConnecting] = useState(false);
  const [revoking, setRevoking] = useState<Agent | null>(null);
  const [renaming, setRenaming] = useState<Agent | null>(null);
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => memdot.agents.list() });

  useEffect(() => {
    if (params.get("connect") !== "1") return;
    setConnecting(true);
    router.replace(pathname);
  }, [params, pathname, router]);

  const active = agents.data?.filter((agent) => !agent.revokedAt) ?? [];
  const revoked = agents.data?.filter((agent) => agent.revokedAt) ?? [];

  return (
    <Page>
      <PageHeader
        title="Agents"
        description="What can act for you, what it can reach, and when it last did. Revoking one stops it at once."
        actions={
          <Button onClick={() => setConnecting(true)}>
            <PlusIcon /> Connect an agent
          </Button>
        }
      />

      {agents.isPending ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-20 rounded-xl" />
          <Skeleton className="h-20 rounded-xl" />
        </div>
      ) : active.length === 0 && revoked.length === 0 ? (
        <Empty className="rounded-xl border border-dashed border-border py-16">
          <EmptyHeader>
            <BotIcon className="mx-auto size-6 text-text-3" aria-hidden="true" />
            <EmptyTitle>No agents connected yet</EmptyTitle>
            <EmptyDescription>
              Give Claude, Cursor or your own code a memory that lasts between sessions.
            </EmptyDescription>
          </EmptyHeader>
          <Button onClick={() => setConnecting(true)}>Connect an agent</Button>
        </Empty>
      ) : (
        <div className="flex flex-col gap-6">
          <AgentList agents={active} onRevoke={setRevoking} onRename={setRenaming} />
          {revoked.length > 0 && (
            <section className="flex flex-col gap-2">
              <h2 className="eyebrow">Revoked</h2>
              <AgentList agents={revoked} />
            </section>
          )}
        </div>
      )}

      <Sheet open={connecting} onOpenChange={setConnecting}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>Connect an agent</SheetTitle>
            <SheetDescription>
              You choose what it can reach, in your browser, when it first connects.
            </SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-6">
            <ConnectInstructions />
          </div>
        </SheetContent>
      </Sheet>

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => !open && setRevoking(null)}
        title={`Revoke ${revoking?.label ?? "this agent"}?`}
        description="Its next call fails, and its spaces move to a new key so it can't read what's written from now on. Anything it already read may have been kept."
        action="Revoke"
        onConfirm={async () => {
          if (!revoking) return;
          await memdot.agents.revoke(revoking);
          await queryClient.invalidateQueries({ queryKey: ["agents"] });
          await queryClient.invalidateQueries({ queryKey: ["keys"] });
          toast.success(`Revoked ${revoking.label}`);
        }}
      />
      <RenameDialog agent={renaming} onClose={() => setRenaming(null)} />
    </Page>
  );
}

function AgentList({
  agents,
  onRevoke,
  onRename,
}: {
  agents: Agent[];
  onRevoke?: (agent: Agent) => void;
  onRename?: (agent: Agent) => void;
}) {
  const spaces = useSpaces();
  const spaceName = (id: string) =>
    spaces.data?.find((space) => space.id === id)?.name ?? "Unnamed space";

  return (
    <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface-1">
      {agents.map((agent) => (
        <li key={agent.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-surface-2">
            {agent.kind === "hosted" ? (
              <PlugIcon className="size-4 text-text-2" aria-hidden="true" />
            ) : (
              <KeyRoundIcon className="size-4 text-text-2" aria-hidden="true" />
            )}
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="truncate text-ui font-medium">{agent.label}</span>
              <Badge variant="outline" className="font-normal">
                {agent.kind === "hosted" ? "Hosted: Assisted only" : "Holds its own key"}
              </Badge>
              {agent.role && (
                <Badge variant="outline" className="font-normal">
                  {ROLE_LABEL[agent.role]}
                </Badge>
              )}
            </div>
            <p className="truncate text-ui-sm text-text-3">
              {agent.spaceIds?.map(spaceName).join(", ") || "No spaces"}
            </p>
            <p className="text-ui-sm text-text-3">
              {agent.revokedAt
                ? `Revoked ${formatRelative(agent.revokedAt)}`
                : agent.lastUsedAt
                  ? `Last used ${formatRelative(agent.lastUsedAt)}`
                  : "Not used yet"}
              {!agent.revokedAt && agent.expiresAt
                ? ` · Stops ${new Date(agent.expiresAt).toLocaleDateString()}`
                : ""}
            </p>
          </div>
          {onRevoke && onRename && (
            <div className="flex shrink-0 gap-1">
              <Button size="sm" variant="ghost" onClick={() => onRename(agent)}>
                Rename
              </Button>
              <Button size="sm" variant="outline" onClick={() => onRevoke(agent)}>
                Revoke
              </Button>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

function RenameDialog({ agent, onClose }: { agent: Agent | null; onClose: () => void }) {
  const memdot = useMemDot();
  const queryClient = useQueryClient();
  const [label, setLabel] = useState("");
  useEffect(() => setLabel(agent?.label ?? ""), [agent]);
  const rename = useMutation({
    mutationFn: () => memdot.agents.rename(agent?.id as string, label.trim()),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
      onClose();
    },
    onError: (error) => toast.error(describeError(error).title),
  });
  return (
    <Dialog open={agent !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (label.trim()) rename.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>Rename this agent</DialogTitle>
            <DialogDescription>A name you'll recognise, on this page only.</DialogDescription>
          </DialogHeader>
          <Input
            aria-label="Name"
            value={label}
            maxLength={LABEL_MAX}
            onChange={(event) => setLabel(event.target.value)}
          />
          <DialogFooter>
            <Button type="submit" disabled={!label.trim() || rename.isPending}>
              {rename.isPending && <Spinner />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
