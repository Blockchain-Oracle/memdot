"use client";

import { BrandLoader } from "@memdot/ui/components/brand";
import { Button } from "@memdot/ui/components/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@memdot/ui/components/empty";
import { PlusIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { NewNamespaceDialog } from "@/components/memory/new-namespace-dialog";
import { useNamespaces } from "@/components/memory/queries";
import { Page, PageHeader } from "@/components/page-header";
import { useCurrentSpace } from "@/lib/queries";

/** "Memory" opens the current space's first namespace, or offers to make one. */
export default function MemoryIndex() {
  const router = useRouter();
  const { data, isPending } = useNamespaces();
  const { space, isPending: spacePending } = useCurrentSpace();
  const [creating, setCreating] = useState(false);
  const first = data?.find((row) => row.spaceId === space?.id) ?? data?.[0];

  useEffect(() => {
    if (first) router.replace(`/memory/${first.id}`);
  }, [first, router]);

  if (isPending || spacePending || first) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <BrandLoader />
      </div>
    );
  }
  return (
    <Page>
      <PageHeader
        title="Memory"
        description="Long-term memory for your agents, stored encrypted on Portaldot V3."
      />
      <Empty className="rounded-xl border border-dashed border-border-strong py-16">
        <EmptyHeader>
          <EmptyTitle>Make your first namespace</EmptyTitle>
          <EmptyDescription>
            One app's or agent's memories, kept apart from the rest. You choose who reads the text.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          {space ? (
            <Button onClick={() => setCreating(true)}>
              <PlusIcon data-icon="inline-start" /> New namespace
            </Button>
          ) : (
            <Button asChild>
              <Link href="/files">Create a space first</Link>
            </Button>
          )}
        </EmptyContent>
      </Empty>
      <NewNamespaceDialog open={creating} onOpenChange={setCreating} />
    </Page>
  );
}
