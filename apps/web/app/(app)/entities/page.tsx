"use client";

import { Button } from "@memdot/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@memdot/ui/components/empty";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@memdot/ui/components/select";
import { Skeleton } from "@memdot/ui/components/skeleton";
import Link from "next/link";
import { useState } from "react";
import { EntitiesTable } from "@/components/memory/entities-table";
import { MODE_COPY } from "@/components/memory/mode-badge";
import { useNamespaces } from "@/components/memory/queries";
import { Page, PageHeader } from "@/components/page-header";

/** Everyone a namespace remembers: users, agents and runs, with what forgetting one would take. */
export default function EntitiesPage() {
  const { data, isPending } = useNamespaces();
  const [chosen, setChosen] = useState<string | null>(null);
  const namespace = data?.find((row) => row.id === chosen) ?? data?.[0];

  return (
    <Page>
      <PageHeader
        title="Entities"
        description="The users, agents and runs your memories are about."
        actions={
          data && data.length > 1 && namespace ? (
            <Select value={namespace.id} onValueChange={setChosen}>
              <SelectTrigger aria-label="Namespace" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {data.map((row) => (
                  <SelectItem key={row.id} value={row.id}>
                    {row.name ?? "Encrypted"} · {MODE_COPY[row.mode].label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : undefined
        }
      />
      {isPending ? (
        <Skeleton className="h-40 w-full rounded-xl" />
      ) : namespace ? (
        <EntitiesTable key={namespace.id} namespace={namespace} />
      ) : (
        <Empty className="rounded-xl border border-dashed border-border-strong py-16">
          <EmptyHeader>
            <EmptyTitle>No namespaces yet</EmptyTitle>
            <EmptyDescription>Entities appear once memories are added for them.</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button asChild>
              <Link href="/memory">Go to Memory</Link>
            </Button>
          </EmptyContent>
        </Empty>
      )}
    </Page>
  );
}
