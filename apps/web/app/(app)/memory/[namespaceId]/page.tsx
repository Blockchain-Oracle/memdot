"use client";

import { Button } from "@memdot/ui/components/button";
import { Skeleton } from "@memdot/ui/components/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@memdot/ui/components/tabs";
import { cn } from "@memdot/ui/lib/utils";
import { PlusIcon } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { EntitiesTable } from "@/components/memory/entities-table";
import { MemoryExplorer } from "@/components/memory/memory-explorer";
import { MODE_COPY, ModeBadge } from "@/components/memory/mode-badge";
import { NamespaceSettings } from "@/components/memory/namespace-settings";
import { NewNamespaceDialog } from "@/components/memory/new-namespace-dialog";
import { useNamespaces } from "@/components/memory/queries";
import { Page, PageHeader } from "@/components/page-header";
import { formatNumber } from "@/lib/format";

export default function NamespacePage() {
  const { namespaceId } = useParams<{ namespaceId: string }>();
  const { data: namespaces, isPending } = useNamespaces();
  const [creating, setCreating] = useState(false);
  const namespace = namespaces?.find((row) => row.id === namespaceId);

  return (
    <Page>
      <div className="grid gap-8 lg:grid-cols-[220px_minmax(0,1fr)]">
        <nav aria-label="Namespaces" className="flex min-w-0 flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="eyebrow">Namespaces</span>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="New namespace"
              onClick={() => setCreating(true)}
            >
              <PlusIcon />
            </Button>
          </div>
          <ul className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible">
            {isPending &&
              [0, 1].map((key) => <Skeleton key={key} className="h-12 w-40 lg:w-full" />)}
            {namespaces?.map((row) => (
              <li key={row.id} className="shrink-0">
                <Link
                  href={`/memory/${row.id}`}
                  aria-current={row.id === namespaceId ? "page" : undefined}
                  className={cn(
                    "flex flex-col gap-0.5 rounded-lg px-3 py-2 transition-colors hover:bg-surface-2",
                    row.id === namespaceId && "bg-surface-2",
                  )}
                >
                  <span className="truncate text-ui">{row.name ?? "Encrypted"}</span>
                  <span className="truncate font-mono text-ui-sm text-text-3 tabular">
                    {formatNumber(row.totalMemories)} · {MODE_COPY[row.mode].label}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <div className="flex min-w-0 flex-col gap-6">
          {!namespace ? (
            isPending ? (
              <Skeleton className="h-64 w-full rounded-xl" />
            ) : (
              <p className="text-ui text-text-3">This namespace isn't here any more.</p>
            )
          ) : (
            <>
              <PageHeader
                title={
                  <span className="flex items-center gap-2">
                    {namespace.name ?? "Encrypted"} <ModeBadge mode={namespace.mode} />
                  </span>
                }
                description={MODE_COPY[namespace.mode].long}
              />
              <Tabs defaultValue="memories" className="gap-5">
                <TabsList>
                  <TabsTrigger value="memories">Memories</TabsTrigger>
                  <TabsTrigger value="entities">Entities</TabsTrigger>
                  <TabsTrigger value="settings">Settings</TabsTrigger>
                </TabsList>
                <TabsContent value="memories">
                  <MemoryExplorer key={namespace.id} namespace={namespace} />
                </TabsContent>
                <TabsContent value="entities">
                  <EntitiesTable namespace={namespace} />
                </TabsContent>
                <TabsContent value="settings">
                  <NamespaceSettings key={namespace.id} namespace={namespace} />
                </TabsContent>
              </Tabs>
            </>
          )}
        </div>
      </div>
      <NewNamespaceDialog open={creating} onOpenChange={setCreating} />
    </Page>
  );
}
