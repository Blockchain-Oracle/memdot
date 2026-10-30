"use client";

import { EyeIcon, EyeOffIcon } from "lucide-react";
import { useState } from "react";
import { cn } from "../lib/utils";
import { CopyButton } from "./copy-button";

/** A secret shown once: masked by default, reveal and copy on the same line. */
export function SecretField({
  value,
  visibleChars = 10,
  className,
}: {
  value: string;
  visibleChars?: number;
  className?: string;
}) {
  const [shown, setShown] = useState(false);
  const masked = `${value.slice(0, visibleChars)}${"•".repeat(Math.max(0, Math.min(24, value.length - visibleChars)))}`;
  return (
    <div
      className={cn(
        "flex h-10 items-center gap-1 rounded-lg border border-border-strong bg-surface-1 pr-1 pl-3",
        className,
      )}
    >
      <code className="min-w-0 flex-1 truncate font-mono text-mono text-foreground">
        {shown ? value : masked}
      </code>
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        aria-label={shown ? "Hide" : "Reveal"}
        className="inline-flex size-7 items-center justify-center rounded-md text-text-3 outline-none hover:bg-surface-2 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        {shown ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
      </button>
      <CopyButton value={value} size="icon" label="Copy" />
    </div>
  );
}
