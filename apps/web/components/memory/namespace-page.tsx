"use client";

import type { Namespace } from "@memdot/sdk";
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
import { MODE_COPY } from "@/components/memory/mode-badge";
import { useNamespaces } from "@/components/memory/queries";
import { Page, PageHeader } from "@/components/page-header";

/** A page about one namespace at a time, with a picker once there's more than one. */
export function NamespacePage({
  title,
  description,
  empty,
  actions,
  children,
}: {
  title: string;
  description: string;
  empty: string;
  actions?: (namespace: Namespace) => React.ReactNode;
  children: (namespace: Namespace) => React.ReactNode;
}) {
  const { data, isPending } = useNamespaces();
  const [chosen, setChosen] = useState<string | null>(null);
  const namespace = data?.find((row) => row.id === chosen) ?? data?.[0];

  return (
    <Page>
      <PageHeader
        title={title}
        description={description}
        actions={
          namespace ? (
            <>
              {actions?.(namespace)}
              {data && data.length > 1 && (
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
              )}
            </>
          ) : undefined
        }
      />
      {isPending ? (
        <Skeleton className="h-40 w-full rounded-xl" />
      ) : namespace ? (
        children(namespace)
      ) : (
        <Empty className="rounded-xl border border-dashed border-border-strong py-16">
          <EmptyHeader>
            <EmptyTitle>No namespaces yet</EmptyTitle>
            <EmptyDescription>{empty}</EmptyDescription>
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
