"use client";

import { Command as CommandPrimitive } from "cmdk";
import { SearchIcon } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import * as React from "react";
import { cn } from "../lib/utils";
import { Kbd } from "./kbd";

// Ported from uvain/command-menu-palette (21st.dev): cmdk ranking and keyboard inside a Radix
// dialog, with group headings, hints, shortcut keys and a footer of key hints.

/** Opens on ⌘K (Mac) or Ctrl+K. Returns [open, setOpen]. */
export function useCommandShortcut(key = "k") {
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === key && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [key]);
  return [open, setOpen] as const;
}

export function CommandMenuGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      className={cn(
        "py-1 [&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pt-1.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:font-mono [&_[cmdk-group-heading]]:text-label [&_[cmdk-group-heading]]:text-text-3 [&_[cmdk-group-heading]]:uppercase",
        className,
      )}
      {...props}
    />
  );
}

export function CommandMenuItem({
  className,
  icon,
  shortcut,
  hint,
  children,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item> & {
  icon?: React.ReactNode;
  /** Display only: "⌘N", "G F". */
  shortcut?: string;
  /** A second line under the label. */
  hint?: React.ReactNode;
}) {
  return (
    <CommandPrimitive.Item
      className={cn(
        "flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 text-ui outline-none select-none",
        "data-[selected=true]:bg-surface-2 data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50",
        "[&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-text-3",
        className,
      )}
      {...props}
    >
      {icon}
      <span className="grid min-w-0 flex-1">
        <span className="truncate">{children}</span>
        {hint && <span className="truncate text-ui-sm text-text-3">{hint}</span>}
      </span>
      {shortcut && (
        <span className="flex gap-1">
          {shortcut.split(" ").map((k) => (
            <Kbd key={k}>{k}</Kbd>
          ))}
        </span>
      )}
    </CommandPrimitive.Item>
  );
}

export function CommandMenu({
  open,
  onOpenChange,
  placeholder = "Search or jump to…",
  emptyText = "No results.",
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  placeholder?: string;
  emptyText?: string;
  children: React.ReactNode;
}) {
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/30 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 dark:bg-black/60" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed top-[12dvh] left-1/2 z-50 w-[calc(100vw-24px)] max-w-[560px] -translate-x-1/2 overflow-hidden rounded-xl border border-border-strong bg-popover shadow-overlay outline-none duration-(--motion-large) data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-[0.98] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98]"
        >
          <DialogPrimitive.Title className="sr-only">Command menu</DialogPrimitive.Title>
          <CommandPrimitive
            loop
            className="flex w-full flex-col overflow-hidden text-popover-foreground"
          >
            <div className="flex items-center gap-2.5 border-b border-border px-3.5">
              <SearchIcon aria-hidden="true" className="size-4 shrink-0 text-text-3" />
              <CommandPrimitive.Input
                placeholder={placeholder}
                className="h-12 w-full bg-transparent text-ui outline-none placeholder:text-text-4"
              />
            </div>
            <CommandPrimitive.List className="max-h-[min(380px,60dvh)] overflow-y-auto overscroll-contain p-1.5">
              <CommandPrimitive.Empty className="px-3 py-8 text-center text-ui-sm text-text-3">
                {emptyText}
              </CommandPrimitive.Empty>
              {children}
            </CommandPrimitive.List>
            <div className="flex items-center gap-4 border-t border-border px-3.5 py-2 text-ui-sm text-text-3">
              <span className="flex items-center gap-1.5">
                <Kbd>↑↓</Kbd> move
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd>↵</Kbd> open
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd>esc</Kbd> close
              </span>
            </div>
          </CommandPrimitive>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
