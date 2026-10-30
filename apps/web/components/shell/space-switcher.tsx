"use client";

import type { Space } from "@memdot/sdk";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@memdot/ui/components/dropdown-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@memdot/ui/components/sidebar";
import { Skeleton } from "@memdot/ui/components/skeleton";
import { cn } from "@memdot/ui/lib/utils";
import { CheckIcon, ChevronsUpDownIcon, PlusIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatBytes } from "@/lib/format";
import { useCurrentSpace, useSpaces } from "@/lib/queries";
import { NewSpaceDialog } from "./new-space-dialog";

/** A 2px usage bar: neutral until 80% of the quota, then warn. */
function UsageBar({ space, className }: { space: Space; className?: string }) {
  const ratio = space.quotaBytes > 0 ? Math.min(1, space.usedBytes / space.quotaBytes) : 0;
  return (
    <span className={cn("block h-0.5 w-full overflow-hidden rounded-full bg-border", className)}>
      <span
        className={cn("block h-full rounded-full", ratio >= 0.8 ? "bg-warn" : "bg-text-3")}
        style={{ width: `${Math.max(ratio * 100, 2)}%` }}
      />
    </span>
  );
}

const initial = (space?: Space) => (space?.name ?? "?").slice(0, 1).toUpperCase();

export function SpaceSwitcher() {
  const router = useRouter();
  const { data: spaces } = useSpaces();
  const { space: current, isPending } = useCurrentSpace();
  const [creating, setCreating] = useState(false);

  if (isPending) return <Skeleton className="h-12 w-full rounded-lg" />;

  return (
    <>
      <SidebarMenu>
        <SidebarMenuItem>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <SidebarMenuButton
                size="lg"
                className="data-[state=open]:bg-sidebar-accent"
                tooltip={current?.name ?? "Spaces"}
              >
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border-strong bg-surface-1 font-medium text-ui">
                  {initial(current)}
                </span>
                <span className="grid min-w-0 flex-1 gap-1 text-left">
                  <span className="truncate text-ui font-medium text-foreground">
                    {current?.name ?? "No space yet"}
                  </span>
                  {current ? (
                    <UsageBar space={current} />
                  ) : (
                    <span className="text-ui-sm text-text-3">Create one</span>
                  )}
                </span>
                <ChevronsUpDownIcon className="ml-auto size-4 text-text-3" />
              </SidebarMenuButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="w-(--radix-dropdown-menu-trigger-width) min-w-64"
            >
              <DropdownMenuLabel className="eyebrow">Spaces</DropdownMenuLabel>
              {spaces?.map((space) => (
                <DropdownMenuItem
                  key={space.id}
                  onSelect={() => router.push(`/spaces/${space.id}`)}
                  className="items-start gap-2.5 py-2"
                >
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-border bg-surface-1 text-ui-sm">
                    {initial(space)}
                  </span>
                  <span className="grid min-w-0 flex-1 gap-1">
                    <span className="truncate">{space.name ?? "Encrypted space"}</span>
                    <span className="font-mono text-ui-sm text-text-3 tabular">
                      {formatBytes(space.usedBytes)} of {formatBytes(space.quotaBytes)}
                      {space.mode === "self_signed" ? " · self-signed" : ""}
                    </span>
                    <UsageBar space={space} />
                  </span>
                  {space.id === current?.id && <CheckIcon className="mt-0.5 size-4" />}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setCreating(true)} className="gap-2.5">
                <PlusIcon className="size-4" /> New space
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </SidebarMenuItem>
      </SidebarMenu>
      <NewSpaceDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}
