"use client";

import type { ApiKey } from "@memdot/sdk";
import { Button } from "@memdot/ui/components/button";
import { Input } from "@memdot/ui/components/input";
import { Label } from "@memdot/ui/components/label";
import { Spinner } from "@memdot/ui/components/spinner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { toast } from "sonner";
import { KeyReveal } from "@/components/keys/key-reveal";
import { RoleChoice } from "@/components/keys/role-choice";
import { describeError } from "@/lib/errors";
import { useMemDot } from "@/lib/memdot";
import { StepFrame } from "./step-frame";

const NAME_MAX = 64;

/** Step 4: a named key with a role; the secret is shown once with a first request beside it. */
export function StepApiKey({ onDone }: { onDone: () => void }) {
  const memdot = useMemDot();
  const queryClient = useQueryClient();
  const id = useId();
  const [name, setName] = useState("my-server");
  const [role, setRole] = useState<ApiKey["role"]>("read_write");
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const spaces = useQuery({ queryKey: ["spaces"], queryFn: () => memdot.spaces.list() });

  if (secret) {
    return (
      <StepFrame
        title="Your API key"
        description="Use it from servers, scripts and agents. Your server unlocks with the recovery code, so files stay encrypted end to end."
        actions={
          <Button size="lg" onClick={onDone}>
            Continue
          </Button>
        }
      >
        <KeyReveal secret={secret} spaceId={spaces.data?.[0]?.id} />
      </StepFrame>
    );
  }

  return (
    <StepFrame
      title="Create an API key"
      description="For your server, scripts and agents. You can add more, rotate or revoke them later."
      actions={
        <>
          <Button
            size="lg"
            disabled={busy || !name.trim()}
            onClick={async () => {
              setBusy(true);
              try {
                const key = await memdot.keys.create({ name: name.trim(), role });
                await queryClient.invalidateQueries({ queryKey: ["keys"] });
                setSecret(key.key);
              } catch (error) {
                toast.error(describeError(error).title);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy && <Spinner data-icon="inline-start" />}
            Create key
          </Button>
          <Button variant="ghost" size="lg" onClick={onDone}>
            Skip for now
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor={id}>Key name</Label>
        <Input
          id={id}
          value={name}
          maxLength={NAME_MAX}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-ui font-medium">Role</span>
        <RoleChoice value={role} onChange={setRole} />
      </div>
    </StepFrame>
  );
}
