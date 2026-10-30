"use client";

import { cn } from "../lib/utils";
import { CopyButton } from "./copy-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip";

const HEAD = 8;
const TAIL = 6;

/** First 8 and last 6 characters, the rest elided (bafkr4ia…q7xa2m). */
export function middleEllipsis(value: string, head = HEAD, tail = TAIL): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}

/**
 * An ID in mono with a middle ellipsis: CIDs, hashes, addresses, key prefixes. The full value is
 * in the tooltip and one click copies it.
 */
export function CidText({
  value,
  head,
  tail,
  copy = true,
  href,
  className,
}: {
  value: string;
  head?: number;
  tail?: number;
  copy?: boolean;
  /** Makes the ID a link (a proof page, say). */
  href?: string;
  className?: string;
}) {
  const text = middleEllipsis(value, head, tail);
  return (
    <span className={cn("group/cid inline-flex min-w-0 items-center gap-0.5", className)}>
      <Tooltip>
        <TooltipTrigger asChild>
          {href ? (
            <a
              href={href}
              className="truncate font-mono text-mono text-foreground tabular underline-offset-4 hover:underline"
            >
              {text}
            </a>
          ) : (
            <span className="truncate font-mono text-mono text-foreground tabular">{text}</span>
          )}
        </TooltipTrigger>
        <TooltipContent className="max-w-[min(90vw,32rem)] font-mono text-[12px] break-all">
          {value}
        </TooltipContent>
      </Tooltip>
      {copy && (
        <CopyButton
          value={value}
          size="icon"
          label="Copy"
          className="size-6 opacity-60 group-hover/cid:opacity-100 focus-visible:opacity-100"
        />
      )}
    </span>
  );
}
