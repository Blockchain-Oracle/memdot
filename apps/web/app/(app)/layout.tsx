"use client";

import { BrandLoader } from "@memdot/ui/components/brand";
import { SidebarInset, SidebarProvider } from "@memdot/ui/components/sidebar";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { AppSidebar } from "@/components/shell/app-sidebar";
import { CommandPalette } from "@/components/shell/command-palette";
import { TopBar } from "@/components/shell/top-bar";
import { useGate } from "@/lib/session";

/** Design §1.5: a 248px sidebar that folds to icons. */
const SIDEBAR_STYLE = {
  "--sidebar-width": "15.5rem",
  "--sidebar-width-icon": "3.5rem",
} as React.CSSProperties;

/**
 * Every dashboard page needs a session and the key on this device; anything else goes to
 * sign-in, setup or unlock and comes back here after.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { gate } = useGate();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    const next = `?next=${encodeURIComponent(pathname)}`;
    if (gate === "sign-in") router.replace(`/sign-in${next}`);
    else if (gate === "setup") router.replace("/setup");
    else if (gate === "unlock") router.replace(`/unlock${next}`);
  }, [gate, pathname, router]);

  if (gate !== "ready") {
    return (
      <main className="flex min-h-svh items-center justify-center">
        <BrandLoader />
      </main>
    );
  }

  return (
    <SidebarProvider style={SIDEBAR_STYLE}>
      <CommandPalette>
        <AppSidebar />
        <SidebarInset className="min-w-0">
          <TopBar />
          <div className="flex flex-1 flex-col">{children}</div>
        </SidebarInset>
      </CommandPalette>
    </SidebarProvider>
  );
}
