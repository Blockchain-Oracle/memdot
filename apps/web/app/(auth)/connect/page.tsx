"use client";

import { BrandLoader } from "@memdot/ui/components/brand";
import { Button } from "@memdot/ui/components/button";
import { Spinner } from "@memdot/ui/components/spinner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2Icon } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
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
  const params = useSearchParams();
  const id = params.get("request");
  const spaces = useSpaces();
  const namespaces = useNamespaces();
  const [choice, setChoice] = useState<AccessChoice>(initialChoice);
  const [stage, setStage] = useState<"idle" | "wrapping" | "done" | "denied">("idle");

  const request = useQuery({
    queryKey: ["connect", id],
    queryFn: () => memdot.agents.connectRequest(id as string),
    enabled: Boolean(id),
    retry: false,
  });

  if (!id) {
    return (
      <ConsentHeader
        title="Nothing to connect"
        description="Run memdot login in your terminal, and it brings you back here."
      />
    );
  }
  if (request.isPending) return <BrandLoader className="mx-auto" />;
  if (request.isError || !request.data) {
    return (
      <ConsentHeader
        title="Couldn't find that request"
        description={describeError(request.error).title}
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

  const closed = request.data.status !== "pending" ? CLOSED[request.data.status] : null;
  if (closed) return <ConsentHeader {...closed} />;

  const label = request.data.label;
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
      await memdot.agents.approveConnect(request.data, {
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
        title={`Connect ${label}`}
        description="It asked from a terminal. It only gets what you choose here."
      />
      <ConsentFacts
        rows={[
          {
            label: "Code",
            value: <span className="font-mono text-ui tracking-wider">{request.data.code}</span>,
          },
          { label: "Runs on", value: label },
          { label: "Holds", value: "Its own key, on that machine" },
        ]}
      />
      <p className="-mt-3 text-center text-ui-sm text-text-3">
        Check this code matches your terminal. If you didn't run memdot login, refuse.
      </p>
      {!fresh ? (
        <ConfirmItsYou />
      ) : spaces.isPending || namespaces.isPending ? (
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
