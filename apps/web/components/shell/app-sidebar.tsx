"use client";

import { BrandMark } from "@memdot/ui/components/brand";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@memdot/ui/components/sidebar";
import { ArrowUpRightIcon, BookOpenIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { DOCS_URL } from "@/lib/env";
import { AccountMenu } from "./account-menu";
import { isActive, NAV } from "./nav";
import { NetworkStatus } from "./network-status";
import { SpaceSwitcher } from "./space-switcher";

/** The selected item carries the ember marker (design: ember marks the active nav item). */
const ACTIVE_MARKER =
  "relative data-[active=true]:font-medium data-[active=true]:text-foreground data-[active=true]:before:absolute data-[active=true]:before:inset-y-2 data-[active=true]:before:left-0 data-[active=true]:before:w-0.5 data-[active=true]:before:rounded-full data-[active=true]:before:bg-ember";

export function AppSidebar() {
  const pathname = usePathname();
  const { setOpenMobile } = useSidebar();
  // On phones the sidebar is a sheet: close it once the next page is chosen.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on every route change
  useEffect(() => setOpenMobile(false), [pathname, setOpenMobile]);
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="gap-3 pt-3">
        <Link
          href="/overview"
          className="flex h-8 items-center gap-2 px-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
        >
          <BrandMark />
          <span className="text-h3 font-medium tracking-tight group-data-[collapsible=icon]:hidden">
            MemDot
          </span>
        </Link>
        <SpaceSwitcher />
      </SidebarHeader>
      <SidebarContent>
        {NAV.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel className="eyebrow">{group.label}</SidebarGroupLabel>
            <SidebarMenu>
              {group.items.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    asChild
                    isActive={isActive(item, pathname)}
                    tooltip={item.title}
                    className={ACTIVE_MARKER}
                  >
                    <Link href={item.href}>
                      <item.icon />
                      <span>{item.title}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter className="gap-1">
        <NetworkStatus />
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="API reference" className="text-text-2">
              <a href={DOCS_URL} target="_blank" rel="noreferrer">
                <BookOpenIcon />
                <span>API reference</span>
                <ArrowUpRightIcon className="ml-auto size-3.5 text-text-3" />
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <AccountMenu />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}
