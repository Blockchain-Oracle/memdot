"use client";

import { toBytes } from "@memdot/chain";
import { DEFAULT_DISPLAY_NAME } from "@memdot/config";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@memdot/ui/components/dropdown-menu";
import { Identicon } from "@memdot/ui/components/identicon";
import { SegmentedControl } from "@memdot/ui/components/segmented-control";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "@memdot/ui/components/sidebar";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronsUpDownIcon, LockIcon, LogOutIcon, SettingsIcon } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import { clearAuthFlow } from "@/lib/auth-flow";
import { useMemDot } from "@/lib/memdot";
import { useMe } from "@/lib/session";

const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`;
const THEMES = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

/** Identicon and name; theme, settings, lock and sign out. */
export function AccountMenu() {
  const memdot = useMemDot();
  const router = useRouter();
  const pathname = usePathname();
  const queryClient = useQueryClient();
  const { data: me } = useMe();
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const owner = me?.account?.ownerAccount;
  const name =
    me?.user.name && me.user.name !== DEFAULT_DISPLAY_NAME && !me.user.name.startsWith("0x")
      ? me.user.name
      : owner
        ? short(owner)
        : "Account";
  const avatar = owner ? (
    <Identicon publicKey={toBytes(owner).slice(0, 32)} size={28} />
  ) : (
    <span className="size-7 rounded-full bg-surface-3" />
  );

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              tooltip={name}
              className="data-[state=open]:bg-sidebar-accent"
            >
              {avatar}
              <span className="grid min-w-0 flex-1 text-left">
                <span className="truncate text-ui text-foreground">{name}</span>
                {owner && (
                  <span className="truncate font-mono text-ui-sm text-text-3">{short(owner)}</span>
                )}
              </span>
              <ChevronsUpDownIcon className="ml-auto size-4 text-text-3" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            side="top"
            align="start"
            className="w-(--radix-dropdown-menu-trigger-width) min-w-60"
          >
            <DropdownMenuLabel className="flex items-center gap-2.5 py-2 font-normal">
              {avatar}
              <span className="grid min-w-0">
                <span className="truncate text-ui text-foreground">{name}</span>
                <span className="truncate text-ui-sm text-text-3">
                  {me?.signIn.passkeys ?? 0} passkey{me?.signIn.passkeys === 1 ? "" : "s"} ·{" "}
                  {me?.signIn.wallets.length ?? 0} wallet
                  {me?.signIn.wallets.length === 1 ? "" : "s"}
                </span>
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <div className="px-1.5 py-1.5">
              {mounted && (
                <SegmentedControl
                  label="Theme"
                  options={THEMES}
                  value={theme ?? "system"}
                  onValueChange={setTheme}
                  className="w-full"
                />
              )}
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => router.push("/settings")}>
              <SettingsIcon /> Settings
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                memdot.account.lock();
                router.replace(`/unlock?next=${encodeURIComponent(pathname)}`);
              }}
            >
              <LockIcon /> Lock
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={async () => {
                await memdot.account.signOut().catch(() => undefined);
                clearAuthFlow();
                queryClient.clear();
                router.replace("/sign-in");
              }}
            >
              <LogOutIcon /> Sign out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
