"use client";

import type { Namespace } from "@memdot/sdk";
import { Button } from "@memdot/ui/components/button";
import { Identicon } from "@memdot/ui/components/identicon";
import { Skeleton } from "@memdot/ui/components/skeleton";
import { Spinner } from "@memdot/ui/components/spinner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeftIcon, RefreshCwIcon, SparklesIcon } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useSyncExternalStore } from "react";
import { toast } from "sonner";
import { MemoryExplorer } from "@/components/memory/memory-explorer";
import { ModeBadge } from "@/components/memory/mode-badge";
import { ModelError } from "@/components/memory/model-error";
import { useNamespace } from "@/components/memory/queries";
import { Page } from "@/components/page-header";
import { describeError } from "@/lib/errors";
import { formatNumber, formatRelative } from "@/lib/format";
import { useMemDot } from "@/lib/memdot";

function readHash(): string {
  try {
    return decodeURIComponent(window.location.hash.slice(1));
  } catch {
    return "";
  }
}

/** The person this page is about, from the part of the address that's never sent anywhere. */
function usePersonId(): string {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener("hashchange", onChange);
      return () => window.removeEventListener("hashchange", onChange);
    },
    readHash,
    () => "",
  );
}

function Profile({ namespace, userId }: { namespace: Namespace; userId: string }) {
  const memdot = useMemDot();
  const queryClient = useQueryClient();
  const key = ["memories", namespace.id, "profile", userId];
  const profile = useQuery({
    queryKey: key,
    queryFn: () => memdot.memories.profile(userId, { namespaceId: namespace.id }),
  });
  const write = useMutation({
    mutationFn: () => memdot.memories.generateProfile(userId, { namespaceId: namespace.id }),
    onSuccess: (written) => queryClient.setQueryData(key, written),
    onError: (error) => {
      if (profile.data?.profile) toast.error(describeError(error).title);
    },
  });

  if (profile.isPending) return <Skeleton className="h-48 w-full rounded-xl" />;
  if (profile.error) {
    return (
      <p className="rounded-xl border border-danger/30 bg-danger/10 p-4 text-ui text-danger-fg">
        {describeError(profile.error).title}
      </p>
    );
  }
  const written = profile.data;
  if (!written.profile) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed border-border-strong p-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-h3">No profile yet</h2>
          <p className="text-ui-sm text-text-3">
            {namespace.mode === "private"
              ? "A short summary of what's remembered, written on this device with your model. One model call, sealed before it's saved."
              : "A short summary of what's remembered, written by the model on the server. One model call, sealed before it's saved."}
          </p>
        </div>
        <Button disabled={write.isPending} onClick={() => write.mutate()}>
          {write.isPending ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <SparklesIcon data-icon="inline-start" />
          )}
          Write a profile
        </Button>
        {write.error && <ModelError error={write.error} />}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border bg-surface-1 p-4">
      <p className="text-ui">{written.profile.summary}</p>
      {written.profile.facts.length > 0 && (
        <dl className="flex flex-col gap-2 border-t border-border pt-3">
          {written.profile.facts.map((fact) => (
            <div key={`${fact.label}:${fact.value}`} className="flex flex-col gap-0.5">
              <dt className="eyebrow">{fact.label}</dt>
              <dd className="text-ui-sm">{fact.value}</dd>
            </div>
          ))}
        </dl>
      )}
      <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
        <span className="text-ui-sm text-text-3">
          Generated from {formatNumber(written.memoriesRead)}{" "}
          {written.memoriesRead === 1 ? "memory" : "memories"}
          {written.generatedAt && `, ${formatRelative(written.generatedAt)}`}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Write it again"
          disabled={write.isPending}
          onClick={() => write.mutate()}
        >
          {write.isPending ? <Spinner /> : <RefreshCwIcon />}
        </Button>
      </div>
    </div>
  );
}

/** One person: what a model makes of them, and everything remembered about them. */
export default function PersonPage() {
  const { namespaceId } = useParams<{ namespaceId: string }>();
  const userId = usePersonId();
  const memdot = useMemDot();
  const { namespace, isPending } = useNamespace(namespaceId);
  const entities = useQuery({
    queryKey: ["entities", namespaceId],
    enabled: Boolean(namespace),
    queryFn: () => memdot.memories.entities({ namespaceId }),
  });
  const entity = entities.data?.find((row) => row.type === "user" && row.id === userId);

  return (
    <Page>
      <Button variant="ghost" size="sm" asChild className="-ml-2 self-start">
        <Link href="/entities">
          <ArrowLeftIcon data-icon="inline-start" /> Entities
        </Link>
      </Button>
      {!namespace || !userId ? (
        isPending ? (
          <Skeleton className="h-64 w-full rounded-xl" />
        ) : (
          <p className="text-ui text-text-3">This person isn't here any more.</p>
        )
      ) : (
        <div className="grid gap-8 lg:grid-cols-[320px_minmax(0,1fr)]">
          <aside className="flex min-w-0 flex-col gap-4">
            <div className="flex items-center gap-3">
              <Identicon publicKey={new TextEncoder().encode(userId)} size={40} />
              <div className="flex min-w-0 flex-col gap-1">
                <h1 className="truncate font-mono text-h3">{userId}</h1>
                <span className="flex flex-wrap items-center gap-2 text-ui-sm text-text-3">
                  <ModeBadge mode={namespace.mode} />
                  {entity && (
                    <>
                      {formatNumber(entity.totalMemories)}{" "}
                      {entity.totalMemories === 1 ? "memory" : "memories"}
                    </>
                  )}
                </span>
              </div>
            </div>
            <Profile key={userId} namespace={namespace} userId={userId} />
          </aside>
          <div className="@container flex min-w-0 flex-col gap-4">
            <MemoryExplorer
              key={userId}
              namespace={namespace}
              initialFilters={[{ id: "person", field: "user", operator: "is", values: [userId] }]}
            />
          </div>
        </div>
      )}
    </Page>
  );
}
