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
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Page } from "@/components/page-header";
import { NewSpaceDialog } from "@/components/shell/new-space-dialog";
import { useCurrentSpace } from "@/lib/queries";

/** "Files" opens the space used last on this device, or offers to create the first one. */
export default function FilesIndex() {
  const router = useRouter();
  const { space, isPending } = useCurrentSpace();
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    if (space) router.replace(`/spaces/${space.id}`);
  }, [space, router]);

  if (isPending || space) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <BrandLoader />
      </div>
    );
  }
  return (
    <Page>
      <Empty className="rounded-xl border border-dashed border-border-strong py-16">
        <EmptyHeader>
          <EmptyTitle>Create your first space</EmptyTitle>
          <EmptyDescription>
            A space holds files and has its own key, so you can share it without sharing anything
            else.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button onClick={() => setCreating(true)}>
            <PlusIcon data-icon="inline-start" /> New space
          </Button>
        </EmptyContent>
      </Empty>
      <NewSpaceDialog open={creating} onOpenChange={setCreating} />
    </Page>
  );
}
