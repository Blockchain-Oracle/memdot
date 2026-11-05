"use client";

import {
  WEBHOOK_EVENTS,
  type Webhook,
  type WebhookDelivery,
  type WebhookEventName,
} from "@memdot/sdk";
import { Badge } from "@memdot/ui/components/badge";
import { Button } from "@memdot/ui/components/button";
import { Checkbox } from "@memdot/ui/components/checkbox";
import { CodeBlock } from "@memdot/ui/components/code-block";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@memdot/ui/components/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@memdot/ui/components/empty";
import { Input } from "@memdot/ui/components/input";
import { JsonViewer } from "@memdot/ui/components/json-viewer";
import { Label } from "@memdot/ui/components/label";
import { SecretField } from "@memdot/ui/components/secret-field";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@memdot/ui/components/sheet";
import { Skeleton } from "@memdot/ui/components/skeleton";
import { Spinner } from "@memdot/ui/components/spinner";
import { Status, StatusIndicator, StatusLabel } from "@memdot/ui/components/status";
import { Switch } from "@memdot/ui/components/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@memdot/ui/components/table";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PlusIcon, RefreshCwIcon, SendIcon, TrashIcon, TriangleAlertIcon } from "lucide-react";
import { useId, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/files/file-dialogs";
import { Page, PageHeader } from "@/components/page-header";
import { describeError } from "@/lib/errors";
import { formatRelative } from "@/lib/format";
import { useMemDot } from "@/lib/memdot";

const LIST_KEY = ["webhooks"];
/** While something's on its way, the log keeps itself current. */
const DELIVERY_POLL_MS = 3000;
/** Shows the visible start of a secret, which is only its `whsec_` prefix and a few characters. */
const SECRET_VISIBLE_CHARS = 10;

const VERIFY_SNIPPET = `import { verifyWebhook } from "@memdot/sdk";

export async function POST(request: Request) {
  const body = await request.text(); // the raw body, as it arrived
  const signature = request.headers.get("x-memdot-signature");
  if (!verifyWebhook(body, signature, process.env.MEMDOT_WEBHOOK_SECRET!)) {
    return new Response("Bad signature", { status: 401 });
  }
  const event = JSON.parse(body); // ids and the event type, never what anything says
  return new Response("OK");
}`;

const fail = (error: unknown) => toast.error(describeError(error).title);

function DeliveryStatus({ status }: { status: WebhookDelivery["status"] }) {
  const variant = status === "delivered" ? "ok" : status === "failed" ? "danger" : "default";
  return (
    <Status variant={variant}>
      <StatusIndicator />
      <StatusLabel className="capitalize">{status}</StatusLabel>
    </Status>
  );
}

function SecretReveal({
  secret,
  onClose,
}: {
  secret: { value: string; title: string } | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={secret !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{secret?.title}</DialogTitle>
          <DialogDescription>Check every delivery against it on your side.</DialogDescription>
        </DialogHeader>
        {secret && (
          <div className="flex min-w-0 flex-col gap-4">
            <SecretField value={secret.value} visibleChars={SECRET_VISIBLE_CHARS} />
            <p className="flex gap-2 text-ui-sm text-text-2">
              <TriangleAlertIcon
                className="mt-0.5 size-4 shrink-0 text-warn-fg"
                aria-hidden="true"
              />
              Copy it now. MemDot can't show it again, but you can replace it.
            </p>
            <CodeBlock lang="typescript" code={VERIFY_SNIPPET} />
          </div>
        )}
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddWebhookDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (secret: string) => void;
}) {
  const memdot = useMemDot();
  const queryClient = useQueryClient();
  const id = useId();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<WebhookEventName[]>([...WEBHOOK_EVENTS]);
  const create = useMutation({
    mutationFn: () => memdot.webhooks.create({ name: name.trim(), url: url.trim(), events }),
    onSuccess: async ({ secret }) => {
      await queryClient.invalidateQueries({ queryKey: LIST_KEY });
      onOpenChange(false);
      setName("");
      setUrl("");
      setEvents([...WEBHOOK_EVENTS]);
      onCreated(secret);
    },
    onError: fail,
  });
  const urlIsBad = url.trim().length > 0 && !url.trim().startsWith("https://");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a webhook</DialogTitle>
          <DialogDescription>
            Deliveries carry ids and the event type, never what a memory or file says.
          </DialogDescription>
        </DialogHeader>
        <form
          id={`${id}-form`}
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            create.mutate();
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-name`}>Name</Label>
            <Input
              id={`${id}-name`}
              value={name}
              placeholder="Order system"
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor={`${id}-url`}>Address</Label>
            <Input
              id={`${id}-url`}
              type="url"
              value={url}
              inputMode="url"
              placeholder="https://example.com/webhooks/memdot"
              aria-invalid={urlIsBad}
              onChange={(event) => setUrl(event.target.value)}
            />
            {urlIsBad && <p className="text-ui-sm text-danger-fg">It has to start with https://</p>}
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1.5 text-ui font-medium">Events</legend>
            {WEBHOOK_EVENTS.map((event) => (
              <div key={event} className="flex items-center gap-2">
                <Checkbox
                  id={`${id}-${event}`}
                  checked={events.includes(event)}
                  onCheckedChange={(on) =>
                    setEvents((list) =>
                      on ? [...list, event] : list.filter((chosen) => chosen !== event),
                    )
                  }
                />
                <Label htmlFor={`${id}-${event}`} className="font-mono font-normal">
                  {event}
                </Label>
              </div>
            ))}
          </fieldset>
        </form>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            form={`${id}-form`}
            disabled={
              create.isPending || !name.trim() || !url.trim() || urlIsBad || events.length === 0
            }
          >
            {create.isPending && <Spinner data-icon="inline-start" />} Add webhook
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeliveryRow({ webhookId, delivery }: { webhookId: string; delivery: WebhookDelivery }) {
  const memdot = useMemDot();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const resend = useMutation({
    mutationFn: () => memdot.webhooks.resend(webhookId, delivery.id),
    onSuccess: async () => {
      toast.success("Sent again.");
      await queryClient.invalidateQueries({ queryKey: [...LIST_KEY, webhookId, "deliveries"] });
    },
    onError: fail,
  });
  return (
    <li className="flex flex-col gap-2 border-b border-border py-3 last:border-0">
      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          aria-expanded={open}
          className="flex min-w-0 flex-1 flex-col items-start gap-1 text-left"
          onClick={() => setOpen((was) => !was)}
        >
          <span className="truncate font-mono text-ui-sm underline-offset-4 hover:underline">
            {delivery.event}
          </span>
          <span className="text-ui-sm text-text-3">
            {formatRelative(delivery.created_at)}
            {delivery.response_status !== null && ` · HTTP ${delivery.response_status}`}
            {delivery.latency_ms !== null && ` · ${delivery.latency_ms} ms`}
            {delivery.attempts > 1 && ` · ${delivery.attempts} tries`}
          </span>
        </button>
        <DeliveryStatus status={delivery.status} />
      </div>
      {open && (
        <div className="flex flex-col gap-2">
          {delivery.error && <p className="text-ui-sm text-danger-fg">{delivery.error}</p>}
          <div className="overflow-x-auto rounded-lg border border-border p-2">
            <JsonViewer value={delivery.payload} />
          </div>
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            disabled={resend.isPending}
            onClick={() => resend.mutate()}
          >
            {resend.isPending ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <RefreshCwIcon data-icon="inline-start" />
            )}
            Send again
          </Button>
        </div>
      )}
    </li>
  );
}

function WebhookSheet({
  webhook,
  onOpenChange,
  onSecret,
}: {
  webhook: Webhook | null;
  onOpenChange: (open: boolean) => void;
  onSecret: (secret: string) => void;
}) {
  const memdot = useMemDot();
  const queryClient = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);
  const webhookId = webhook?.id ?? "";
  const deliveries = useQuery({
    queryKey: [...LIST_KEY, webhookId, "deliveries"],
    enabled: webhook !== null,
    queryFn: () => memdot.webhooks.deliveries(webhookId),
    refetchInterval: (query) =>
      query.state.data?.some((delivery) => delivery.status === "pending")
        ? DELIVERY_POLL_MS
        : false,
  });
  const test = useMutation({
    mutationFn: () => memdot.webhooks.test(webhookId),
    onSuccess: async () => {
      toast.success("Test event on its way.");
      await queryClient.invalidateQueries({ queryKey: [...LIST_KEY, webhookId, "deliveries"] });
    },
    onError: fail,
  });
  return (
    <Sheet open={webhook !== null} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{webhook?.name}</SheetTitle>
          <SheetDescription className="font-mono break-all">{webhook?.url}</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-6 px-4 pb-6">
          <div className="flex flex-wrap gap-1.5">
            {webhook?.events.map((event) => (
              <Badge key={event} variant="outline" className="font-mono font-normal">
                {event}
              </Badge>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={test.isPending}
              onClick={() => test.mutate()}
            >
              {test.isPending ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <SendIcon data-icon="inline-start" />
              )}
              Send a test
            </Button>
            <Button variant="outline" size="sm" onClick={() => setConfirmRotate(true)}>
              <RefreshCwIcon data-icon="inline-start" /> Replace secret
            </Button>
            <Button variant="outline" size="sm" onClick={() => setConfirmDelete(true)}>
              <TrashIcon data-icon="inline-start" /> Delete
            </Button>
          </div>
          <section className="flex flex-col gap-1">
            <h3 className="eyebrow">Deliveries</h3>
            {deliveries.isPending ? (
              <Skeleton className="h-24 w-full" />
            ) : deliveries.error ? (
              <p className="text-ui-sm text-danger-fg">{describeError(deliveries.error).title}</p>
            ) : deliveries.data.length === 0 ? (
              <p className="py-6 text-center text-ui-sm text-text-3">
                Nothing sent yet. Send a test to check the address.
              </p>
            ) : (
              <ul>
                {deliveries.data.map((delivery) => (
                  <DeliveryRow key={delivery.id} webhookId={webhookId} delivery={delivery} />
                ))}
              </ul>
            )}
          </section>
        </div>
      </SheetContent>
      <ConfirmDialog
        open={confirmRotate}
        onOpenChange={setConfirmRotate}
        title="Replace the signing secret?"
        description="The old one stops at once, so your receiver will refuse deliveries until it has the new one."
        action="Replace secret"
        onConfirm={async () => {
          const { secret } = await memdot.webhooks.rotate(webhookId);
          onSecret(secret);
        }}
      />
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${webhook?.name}?`}
        description="Nothing more is sent to it, and its delivery log goes too."
        action="Delete"
        onConfirm={async () => {
          await memdot.webhooks.delete(webhookId);
          await queryClient.invalidateQueries({ queryKey: LIST_KEY });
          onOpenChange(false);
        }}
      />
    </Sheet>
  );
}

/** Tell another service when memories and files change, signed, with ids only. */
export default function WebhooksPage() {
  const memdot = useMemDot();
  const queryClient = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [secret, setSecret] = useState<{ value: string; title: string } | null>(null);
  const list = useQuery({ queryKey: LIST_KEY, queryFn: () => memdot.webhooks.list() });
  const setActive = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      memdot.webhooks.update(id, { active }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: LIST_KEY }),
    onError: fail,
  });
  const open = list.data?.find((webhook) => webhook.id === openId) ?? null;

  return (
    <Page>
      <PageHeader
        title="Webhooks"
        description="Tell another service when memories and files change. Signed, with ids only."
        actions={
          <Button onClick={() => setAdding(true)}>
            <PlusIcon data-icon="inline-start" /> Add webhook
          </Button>
        }
      />
      {list.isPending ? (
        <Skeleton className="h-40 w-full rounded-xl" />
      ) : list.error ? (
        <p className="rounded-xl border border-danger/30 bg-danger/10 p-4 text-ui text-danger-fg">
          {describeError(list.error).title}
        </p>
      ) : list.data.length === 0 ? (
        <Empty className="rounded-xl border border-dashed border-border-strong py-16">
          <EmptyHeader>
            <EmptyTitle>No webhooks yet</EmptyTitle>
            <EmptyDescription>
              Point one at your service to hear about new memories and stored files as they happen.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button onClick={() => setAdding(true)}>
              <PlusIcon data-icon="inline-start" /> Add the first webhook
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-surface-1">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Webhook</TableHead>
                <TableHead className="hidden sm:table-cell">Events</TableHead>
                <TableHead className="hidden sm:table-cell">Added</TableHead>
                <TableHead className="w-14 text-right">On</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.data.map((webhook) => (
                <TableRow key={webhook.id}>
                  <TableCell className="max-w-56">
                    <button
                      type="button"
                      className="flex w-full min-w-0 flex-col gap-0.5 text-left"
                      onClick={() => setOpenId(webhook.id)}
                    >
                      <span className="truncate text-ui underline-offset-4 hover:underline">
                        {webhook.name}
                      </span>
                      <span className="truncate font-mono text-ui-sm text-text-3">
                        {webhook.url}
                      </span>
                    </button>
                  </TableCell>
                  <TableCell className="hidden font-mono text-ui-sm text-text-2 tabular sm:table-cell">
                    {webhook.events.length} of {WEBHOOK_EVENTS.length}
                  </TableCell>
                  <TableCell className="hidden text-ui-sm text-text-3 sm:table-cell">
                    {formatRelative(webhook.created_at)}
                  </TableCell>
                  <TableCell className="text-right">
                    <Switch
                      aria-label={`${webhook.name} on`}
                      checked={webhook.active}
                      onCheckedChange={(active) => setActive.mutate({ id: webhook.id, active })}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <AddWebhookDialog
        open={adding}
        onOpenChange={setAdding}
        onCreated={(value) => setSecret({ value, title: "Your webhook's signing secret" })}
      />
      <WebhookSheet
        webhook={open}
        onOpenChange={(next) => !next && setOpenId(null)}
        onSecret={(value) => setSecret({ value, title: "The new signing secret" })}
      />
      <SecretReveal secret={secret} onClose={() => setSecret(null)} />
    </Page>
  );
}
