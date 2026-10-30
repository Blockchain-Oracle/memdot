"use client";

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@memdot/ui/components/breadcrumb";
import { Button } from "@memdot/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@memdot/ui/components/dropdown-menu";
import { Kbd } from "@memdot/ui/components/kbd";
import { Separator } from "@memdot/ui/components/separator";
import { SidebarTrigger } from "@memdot/ui/components/sidebar";
import { FolderPlusIcon, KeyRoundIcon, PlusIcon, SearchIcon, UploadIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { useCurrentSpace } from "@/lib/queries";
import { useOpenPalette } from "./command-palette";
import { isActive, NAV_ITEMS } from "./nav";
import { NewSpaceDialog } from "./new-space-dialog";
import { TxTray } from "./tx-tray";

export function TopBar() {
  const pathname = usePathname();
  const router = useRouter();
  const openPalette = useOpenPalette();
  const { space } = useCurrentSpace();
  const [creating, setCreating] = useState(false);
  const page = NAV_ITEMS.find((item) => isActive(item, pathname));
  const inSpace = pathname.startsWith("/spaces/");

  return (
    <header className="sticky top-0 z-20 flex h-12 shrink-0 items-center gap-2 border-b border-border bg-background px-3">
      <SidebarTrigger className="-ml-1 text-text-3" />
      <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
      <Breadcrumb className="min-w-0 flex-1">
        <BreadcrumbList className="flex-nowrap">
          {inSpace ? (
            <>
              <BreadcrumbItem className="hidden sm:inline-flex">
                <Link href="/files" className="text-text-3 hover:text-foreground">
                  Files
                </Link>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden sm:inline-flex" />
              <BreadcrumbItem className="min-w-0">
                <BreadcrumbPage className="truncate">{space?.name ?? "Space"}</BreadcrumbPage>
              </BreadcrumbItem>
            </>
          ) : (
            <BreadcrumbItem>
              <BreadcrumbPage>{page?.title ?? "MemDot"}</BreadcrumbPage>
            </BreadcrumbItem>
          )}
        </BreadcrumbList>
      </Breadcrumb>

      <Button
        variant="outline"
        size="sm"
        onClick={openPalette}
        className="w-9 justify-center px-0 text-text-3 md:w-56 md:justify-start md:px-2.5"
        aria-label="Search"
      >
        <SearchIcon />
        <span className="hidden flex-1 text-left md:inline">Search…</span>
        <Kbd className="hidden md:inline-flex">⌘K</Kbd>
      </Button>
      <TxTray />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button size="sm" aria-label="New">
            <PlusIcon />
            <span className="hidden sm:inline">New</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          {space && (
            <DropdownMenuItem onSelect={() => router.push(`/spaces/${space.id}?upload=1`)}>
              <UploadIcon /> Upload files
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => setCreating(true)}>
            <FolderPlusIcon /> New space
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => router.push("/keys?new=1")}>
            <KeyRoundIcon /> New API key
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <NewSpaceDialog open={creating} onOpenChange={setCreating} />
    </header>
  );
}
