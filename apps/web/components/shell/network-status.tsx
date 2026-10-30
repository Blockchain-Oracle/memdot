"use client";

import { Tooltip, TooltipContent, TooltipTrigger } from "@memdot/ui/components/tooltip";
import { cn } from "@memdot/ui/lib/utils";
import { useChainHead } from "@/lib/chain";
import { RPC_URL } from "@/lib/env";
import { formatNumber } from "@/lib/format";

/** "V3 testnet · #249,600": the finalized head, ticking, from this browser's own connection. */
export function NetworkStatus({ className }: { className?: string }) {
  const { block, status } = useChainHead();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div
          className={cn(
            "flex h-8 items-center gap-2 rounded-lg px-2 text-ui-sm text-text-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0",
            className,
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              status === "live" && "bg-ok",
              status === "connecting" && "animate-pulse bg-warn",
              status === "down" && "bg-danger",
            )}
          />
          <span className="truncate group-data-[collapsible=icon]:hidden">
            {status === "down" ? "V3 unreachable" : "V3 testnet"}
            {block !== null && (
              <span className="font-mono text-text-3 tabular"> · #{formatNumber(block)}</span>
            )}
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="right" className="font-mono text-[12px]">
        {status === "live" ? "Finalized head, read directly from" : "Connecting to"} {RPC_URL}
      </TooltipContent>
    </Tooltip>
  );
}
