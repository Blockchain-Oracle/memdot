"use client";

import { DownloadIcon, TriangleAlertIcon } from "lucide-react";
import { useId } from "react";
import { cn } from "../lib/utils";
import { Button } from "./button";
import { Checkbox } from "./checkbox";
import { CopyButton } from "./copy-button";
import { Label } from "./label";

/**
 * A recovery code shown once: numbered words in a two-column grid, copy and download, a warning,
 * and an acknowledgement that gates the next step.
 */
export function RecoveryCodeGrid({
  code,
  acknowledged,
  onAcknowledgedChange,
  fileName = "memdot-recovery-code.txt",
  className,
}: {
  code: string;
  acknowledged: boolean;
  onAcknowledgedChange: (value: boolean) => void;
  fileName?: string;
  className?: string;
}) {
  const id = useId();
  const words = code.trim().split(/\s+/);
  const download = () => {
    const blob = new Blob(
      [
        `MemDot recovery code\n\n${code}\n\nKeep it offline. It signs in and unlocks your account on any device.\n`,
      ],
      { type: "text/plain" },
    );
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      <ol className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-3">
        {words.map((word, i) => (
          <li
            key={i}
            className="flex items-baseline gap-2 bg-surface-1 px-3 py-2.5 font-mono text-mono"
          >
            <span className="w-5 text-right text-label text-text-4 tabular">{i + 1}</span>
            <span className="text-foreground">{word}</span>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        <CopyButton value={code} label="Copy" />
        <Button variant="outline" onClick={download}>
          <DownloadIcon data-icon="inline-start" />
          Download .txt
        </Button>
      </div>
      <p className="flex gap-2 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2.5 text-ui-sm text-text-2">
        <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-warn-fg" aria-hidden="true" />
        This code is shown once. It signs in and unlocks your account on any device, and MemDot
        cannot recover it for you.
      </p>
      <div className="flex items-center gap-2.5">
        <Checkbox
          id={id}
          checked={acknowledged}
          onCheckedChange={(value) => onAcknowledgedChange(value === true)}
        />
        <Label htmlFor={id} className="text-ui font-normal">
          I stored it somewhere safe
        </Label>
      </div>
    </div>
  );
}
