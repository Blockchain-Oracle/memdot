"use client";

import type { MemoryMode } from "@memdot/sdk";
import { Badge } from "@memdot/ui/components/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@memdot/ui/components/tooltip";
import { EyeOffIcon, LockIcon } from "lucide-react";

export const MODE_COPY: Record<MemoryMode, { label: string; short: string; long: string }> = {
  private: {
    label: "Private",
    short: "Read only on your device",
    long: "Extracted and searched on your device, with your own model key. MemDot only holds encrypted segments and their ids.",
  },
  assisted: {
    label: "Assisted",
    short: "The server reads text to extract",
    long: "MemDot's server reads text to extract memories and keeps a search index. The text is never stored in the clear, and you can read it all without MemDot.",
  },
};

/** R10: which mode a namespace is in shows wherever its memories do. */
export function ModeBadge({ mode }: { mode: MemoryMode }) {
  const copy = MODE_COPY[mode];
  const Icon = mode === "private" ? LockIcon : EyeOffIcon;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge variant="outline" className="gap-1 font-normal">
          <Icon className="size-3" aria-hidden="true" />
          {copy.label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent className="max-w-64">{copy.long}</TooltipContent>
    </Tooltip>
  );
}
