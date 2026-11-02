"use client";

import { Button } from "@memdot/ui/components/button";
import { Status, StatusIndicator, StatusLabel } from "@memdot/ui/components/status";
import { useQuery } from "@tanstack/react-query";
import { ConnectInstructions } from "@/components/agents/connect-instructions";
import { useMemDot } from "@/lib/memdot";
import { StepFrame } from "./step-frame";

const WATCH_MS = 3_000;

/** Step 5: an agent is connected in another window, and this one flips when it arrives. */
export function StepConnectAgent({ onDone }: { onDone: () => void }) {
  const memdot = useMemDot();
  const agents = useQuery({
    queryKey: ["agents"],
    queryFn: () => memdot.agents.list(),
    refetchInterval: WATCH_MS,
  });
  const connected = agents.data?.find((agent) => !agent.revokedAt);

  return (
    <StepFrame
      title="Connect an agent"
      description="Give Claude, Cursor or your own code a memory it keeps between sessions. You choose what it can reach, and you can revoke it any time."
      actions={
        <>
          <Button size="lg" onClick={onDone} variant={connected ? "default" : "ghost"}>
            {connected ? "Continue" : "Skip for now"}
          </Button>
          <Status variant={connected ? "ok" : "live"} className="ml-auto">
            <StatusIndicator />
            <StatusLabel>
              {connected ? `Connected: ${connected.label}` : "Waiting for an agent…"}
            </StatusLabel>
          </Status>
        </>
      }
    >
      <ConnectInstructions />
    </StepFrame>
  );
}
