"use client";

import { BrandLoader } from "@memdot/ui/components/brand";
import { Button } from "@memdot/ui/components/button";
import { Spinner } from "@memdot/ui/components/spinner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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

export default function OAuthConsentPage() {
  return (
    <AuthFrame wide>
      <Suspense>
        <Consent />
      </Suspense>
    </AuthFrame>
  );
}

function hostOf(uri: string | null): string {
  if (!uri) return "Unknown";
  try {
    return new URL(uri).host;
  } catch {
    return uri;
  }
}

/** What the OAuth server shows before an MCP client gets a token. Nothing is wrapped: it holds no key. */
function Consent() {
  const memdot = useMemDot();
  const router = useRouter();
  const queryClient = useQueryClient();
  const params = useSearchParams();
  const clientId = params.get("client_id");
  const redirectUri = params.get("redirect_uri");
  const { gate, me } = useGate();
  const ready = gate === "ready";
  const spaces = useSpaces();
  const namespaces = useNamespaces();
  const [choice, setChoice] = useState<AccessChoice>(() => ({
    ...initialChoice(),
    newNamespaceMode: "assisted",
  }));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const next = `?next=${encodeURIComponent(hereWithQuery())}`;
    if (gate === "sign-in") router.replace(`/sign-in${next}`);
    else if (gate === "setup") router.replace("/setup");
    else if (gate === "unlock") router.replace(`/unlock${next}`);
  }, [gate, router]);

  const client = useQuery({
    queryKey: ["oauth-client", clientId],
    queryFn: () => memdot.agents.oauthClient(clientId as string),
    enabled: ready && Boolean(clientId),
    retry: false,
  });

  if (!clientId) {
    return (
      <ConsentHeader title="Nothing to approve" description="This link is missing its request." />
    );
  }
  if (!ready || client.isPending) return <BrandLoader className="mx-auto" />;

  const name = client.data?.client_name ?? "An MCP client";
  const query = () => window.location.search.slice(1);

  const answer = async (accept: boolean) => {
    setBusy(true);
    try {
      if (accept) {
        const made = makesNamespace(choice)
          ? await memdot.memories.createNamespace({
              spaceId: choice.spaceIds[0] as string,
              name: choice.newNamespaceName.trim(),
              mode: "assisted",
            })
          : null;
        await queryClient.invalidateQueries({ queryKey: ["namespaces"] });
        const reachable = (namespaces.data ?? [])
          .filter((row) => choice.spaceIds.includes(row.spaceId) && row.mode === "assisted")
          .map((row) => ({ id: row.id, name: row.name }));
        const namespaceId = made?.id ?? (choice.namespaceId as string);
        await memdot.agents.allowHosted({
          clientId,
          role: choice.role,
          spaceIds: choice.spaceIds,
          namespaces: [...reachable, ...(made ? [{ id: made.id, name: made.name }] : [])],
          namespaceId,
          ...expiryDays(choice),
        });
      }
      window.location.assign(await memdot.agents.answerOAuth(query(), accept));
    } catch (error) {
      setBusy(false);
      toast.error(describeError(error).title);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <ConsentHeader
        title={`Connect ${name}`}
        description="It's asking to use your memories over MCP. It only gets what you choose here."
      />
      <ConsentFacts
        rows={[
          { label: "Calls itself", value: name },
          { label: "Sends you back to", value: hostOf(redirectUri) },
          { label: "Reaches", value: "Assisted namespaces only" },
        ]}
      />
      <p className="-mt-3 text-center text-ui-sm text-text-3">
        Anything can call itself anything. If you didn't just add this, cancel.
      </p>
      {me && !me.signIn.fresh ? (
        <ConfirmItsYou />
      ) : spaces.isPending || namespaces.isPending ? (
        <BrandLoader className="mx-auto" />
      ) : (
        <>
          <AccessChooser
            spaces={spaces.data ?? []}
            namespaces={namespaces.data ?? []}
            hosted
            value={choice}
            onChange={setChoice}
          />
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" disabled={busy} onClick={() => answer(false)}>
              Cancel
            </Button>
            <Button disabled={!complete(choice, true) || busy} onClick={() => answer(true)}>
              {busy && <Spinner />}
              Connect
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
