"use client";

import {
  CommandMenu,
  CommandMenuGroup,
  CommandMenuItem,
  useCommandShortcut,
} from "@memdot/ui/components/command-menu";
import {
  ArrowUpRightIcon,
  FolderIcon,
  KeyRoundIcon,
  LockIcon,
  MoonIcon,
  PlusIcon,
  UploadIcon,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { createContext, useContext, useState } from "react";
import { DOCS_URL } from "@/lib/env";
import { useMemDot } from "@/lib/memdot";
import { useCurrentSpace, useSpaces } from "@/lib/queries";
import { NAV_ITEMS } from "./nav";
import { NewSpaceDialog } from "./new-space-dialog";

const PaletteContext = createContext<() => void>(() => undefined);

/** Opens ⌘K from anywhere inside the shell (the top-bar search button uses it). */
export const useOpenPalette = () => useContext(PaletteContext);

export function CommandPalette({ children }: { children: React.ReactNode }) {
  const memdot = useMemDot();
  const router = useRouter();
  const pathname = usePathname();
  const { resolvedTheme, setTheme } = useTheme();
  const { data: spaces } = useSpaces();
  const { space } = useCurrentSpace();
  const [open, setOpen] = useCommandShortcut();
  const [creating, setCreating] = useState(false);

  const run = (task: () => void) => {
    setOpen(false);
    task();
  };

  return (
    <PaletteContext value={() => setOpen(true)}>
      {children}
      <CommandMenu
        open={open}
        onOpenChange={setOpen}
        placeholder="Search pages, spaces and actions…"
      >
        <CommandMenuGroup heading="Actions">
          {space && (
            <CommandMenuItem
              icon={<UploadIcon />}
              keywords={["store", "add", "file"]}
              onSelect={() => run(() => router.push(`/spaces/${space.id}?upload=1`))}
            >
              Upload files
            </CommandMenuItem>
          )}
          <CommandMenuItem icon={<PlusIcon />} onSelect={() => run(() => setCreating(true))}>
            New space
          </CommandMenuItem>
          <CommandMenuItem
            icon={<KeyRoundIcon />}
            keywords={["api", "token"]}
            onSelect={() => run(() => router.push("/keys?new=1"))}
          >
            New API key
          </CommandMenuItem>
        </CommandMenuGroup>
        <CommandMenuGroup heading="Go to">
          {NAV_ITEMS.map((item) => (
            <CommandMenuItem
              key={item.href}
              icon={<item.icon />}
              keywords={item.keywords}
              onSelect={() => run(() => router.push(item.href))}
            >
              {item.title}
            </CommandMenuItem>
          ))}
        </CommandMenuGroup>
        {spaces && spaces.length > 0 && (
          <CommandMenuGroup heading="Spaces">
            {spaces.map((s) => (
              <CommandMenuItem
                key={s.id}
                value={`space ${s.name ?? s.id}`}
                icon={<FolderIcon />}
                onSelect={() => run(() => router.push(`/spaces/${s.id}`))}
              >
                {s.name ?? "Encrypted space"}
              </CommandMenuItem>
            ))}
          </CommandMenuGroup>
        )}
        <CommandMenuGroup heading="Account">
          <CommandMenuItem
            icon={<MoonIcon />}
            keywords={["dark", "light", "appearance"]}
            onSelect={() => run(() => setTheme(resolvedTheme === "dark" ? "light" : "dark"))}
          >
            Switch to {resolvedTheme === "dark" ? "light" : "dark"} theme
          </CommandMenuItem>
          <CommandMenuItem
            icon={<LockIcon />}
            onSelect={() =>
              run(() => {
                memdot.account.lock();
                router.replace(`/unlock?next=${encodeURIComponent(pathname)}`);
              })
            }
          >
            Lock MemDot
          </CommandMenuItem>
          <CommandMenuItem
            icon={<ArrowUpRightIcon />}
            keywords={["help", "reference", "api"]}
            onSelect={() => run(() => window.open(DOCS_URL, "_blank", "noreferrer"))}
          >
            API reference
          </CommandMenuItem>
        </CommandMenuGroup>
      </CommandMenu>
      <NewSpaceDialog open={creating} onOpenChange={setCreating} />
    </PaletteContext>
  );
}
