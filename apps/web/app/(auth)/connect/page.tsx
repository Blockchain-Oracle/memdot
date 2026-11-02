"use client";

import type { ConnectRequest } from "@memdot/sdk";
import { BrandLoader } from "@memdot/ui/components/brand";
import { Button } from "@memdot/ui/components/button";
import { Input } from "@memdot/ui/components/input";
import { Label } from "@memdot/ui/components/label";
import { Spinner } from "@memdot/ui/components/spinner";
import { useQueryClient } from "@tanstack/react-query";
import { CheckCircle2Icon } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import {
  type AccessChoice,
  AccessChooser,
  complete,
  expiryDays,
  initialChoice,
  makesNamespace,
} from "@/components/agents/access-chooser";
import { ConfirmItsYou, ConsentFacts, ConsentHeader } from "@/components/agents/consent-frame";
import { AuthFrame } from "@/components/auth/auth-frame";
import { useNamespaces } from "@/components/memory/queries";
import { describeError } from "@/lib/errors";
import { useMemDot } from "@/lib/memdot";
import { useSpaces } from "@/lib/queries";
import { hereWithQuery, useGate } from "@/lib/session";

export default function ConnectPage() {
  return (
    <AuthFrame wide>
      <Suspense>
        <Connect />
      </Suspense>
    </AuthFrame>
  );
}

const CODE_MAX = 16;

const CLOSED: Record<string, { title: string; description: string }> = {
  denied: { title: "Refused", description: "This request was refused. Nothing was connected." },
  expired: {
    title: "This request has expired",
    description: "They last ten minutes. Run memdot login again.",
  },
  approved: {
    title: "Already connected",
    description: "This request was approved. Go back to your terminal.",
  },
  delivered: {
    title: "Already connected",
    description: "This request was approved. Go back to your terminal.",
  },
};

/** The `memdot login` consent page: the owner chooses, and their browser wraps the keys. */
function Connect() {
  const router = useRouter();
  const { gate, me } = useGate();

  useEffect(() => {
    const next = `?next=${encodeURIComponent(hereWithQuery())}`;
    if (gate === "sign-in") router.replace(`/sign-in${next}`);
    else if (gate === "setup") router.replace("/setup");
    else if (gate === "unlock") router.replace(`/unlock${next}`);
  }, [gate, router]);

  // Names are sealed: anything read before the unlock would come back, and stay, unnamed.
  if (gate !== "ready") return <BrandLoader className="mx-auto" />;
  return <ConnectForm fresh={me?.signIn.fresh ?? false} />;
}

function ConnectForm({ fresh }: { fresh: boolean }) {
  const memdot = useMemDot();
  const queryClient = useQueryClient();
  const id = useSearchParams().get("request");
  const spaces = useSpaces();
  const namespaces = useNamespaces();
  const [request, setRequest] = useState<ConnectRequest | null>(null);
  const [choice, setChoice] = useState<AccessChoice>(initialChoice);
  const [stage, setStage] = useState<"idle" | "wrapping" | "done" | "denied">("idle");

  if (!id) {
    return (
      <ConsentHeader
        title="Nothing to connect"
        description="Run memdot login in your terminal, and it brings you back here."
      />
    );
  }

  if (stage === "done") {
    return (
      <div className="flex flex-col items-center gap-5 text-center">
        <CheckCircle2Icon className="size-9 text-ok" aria-hidden="true" />
        <div className="flex flex-col gap-1.5">
          <h1 className="text-h1">Connected</h1>
          <p className="text-ui text-text-2">
            Go back to your terminal: it picks this up in a moment.
          </p>
        </div>
        <Button variant="outline" asChild>
          <Link href="/agents">See your agents</Link>
        </Button>
      </div>
    );
  }
  if (stage === "denied") {
    return <ConsentHeader title="Refused" description="Nothing was connected." />;
  }

  if (!request) return <CodeEntry id={id} fresh={fresh} onClaimed={setRequest} />;

  const closed = request.status !== "pending" ? CLOSED[request.status] : null;
  if (closed) return <ConsentHeader {...closed} />;

  const approve = async () => {
    setStage("wrapping");
    try {
      const made = makesNamespace(choice)
        ? await memdot.memories.createNamespace({
            spaceId: choice.spaceIds[0] as string,
            name: choice.newNamespaceName.trim(),
            mode:
              spaces.data?.find((space) => space.id === choice.spaceIds[0])?.mode === "sponsored"
                ? choice.newNamespaceMode
                : "private",
          })
        : null;
      const namespaceId = made?.id ?? choice.namespaceId;
      await memdot.agents.approveConnect(request, {
        spaceIds: choice.spaceIds,
        role: choice.role,
        ...(namespaceId ? { namespaceId } : {}),
        ...expiryDays(choice),
      });
      await queryClient.invalidateQueries({ queryKey: ["namespaces"] });
      setStage("done");
    } catch (error) {
      setStage("idle");
      toast.error(describeError(error).title);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <ConsentHeader
        title="Connect this device"
        description="It only gets what you choose here, and it holds its own key on that machine."
      />
      <ConsentFacts
        rows={[
          { label: "Calls itself", value: request.label },
          ...(request.requestedFrom ? [{ label: "Asked from", value: request.requestedFrom }] : []),
        ]}
      />
      {spaces.isPending || namespaces.isPending ? (
        <BrandLoader className="mx-auto" />
      ) : (
        <>
          <AccessChooser
            spaces={spaces.data ?? []}
            namespaces={namespaces.data ?? []}
            hosted={false}
            value={choice}
            onChange={setChoice}
          />
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="ghost"
              disabled={stage === "wrapping"}
              onClick={async () => {
                await memdot.agents.denyConnect(id).catch(() => undefined);
                setStage("denied");
              }}
            >
              Refuse
            </Button>
            <Button disabled={!complete(choice, false) || stage === "wrapping"} onClick={approve}>
              {stage === "wrapping" && <Spinner />}
              {stage === "wrapping" ? "Wrapping keys…" : "Connect"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * The code has to come from the terminal: a link alone reaches nothing, so nobody can be sent one
 * and talked into a single click. It's asked for here rather than checked by eye.
 */
function CodeEntry({
  id,
  fresh,
  onClaimed,
}: {
  id: string;
  fresh: boolean;
  onClaimed: (request: ConnectRequest) => void;
}) {
  const memdot = useMemDot();
  const fieldId = useId();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-col gap-6">
      <ConsentHeader
        title="Connect a device"
        description="Only go on if you just ran memdot login yourself. If someone sent you here, close this page."
      />
      {fresh ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            try {
              onClaimed(await memdot.agents.claimConnect(id, code));
            } catch (error) {
              toast.error(describeError(error).title);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Label htmlFor={fieldId}>The code your terminal shows</Label>
          <Input
            id={fieldId}
            value={code}
            maxLength={CODE_MAX}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            placeholder="XXXX-XXXX"
            className="font-mono tracking-wider uppercase"
            onChange={(event) => setCode(event.target.value)}
          />
          <Button type="submit" disabled={code.trim().length === 0 || busy} className="self-end">
            {busy && <Spinner />}
            Continue
          </Button>
        </form>
      ) : (
        <ConfirmItsYou />
      )}
    </div>
  );
}
