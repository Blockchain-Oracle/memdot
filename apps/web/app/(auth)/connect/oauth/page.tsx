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
import { hereWithQuery, setupFor, useGate } from "@/lib/session";

export default function OAuthConsentPage() {
  return (
    <AuthFrame wide>
      <Suspense>
        <Consent />
      </Suspense>
    </AuthFrame>
  );
}

/** Clients we'd show a logo for, once their address proves who they are. */
const RECOGNISED_HOSTS = new Set(["claude.ai", "cursor.com", "openai.com", "chatgpt.com"]);

/** A client whose id is a web address proved it controls that address when it was fetched. */
function identifiedBy(clientId: string): string | null {
  try {
    const url = new URL(clientId);
    return url.protocol === "https:" ? url.host : null;
  } catch {
    return null;
  }
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
  const router = useRouter();
  const { gate, me } = useGate();

  useEffect(() => {
    const next = `?next=${encodeURIComponent(hereWithQuery())}`;
    if (gate === "sign-in") router.replace(`/sign-in${next}`);
    else if (gate === "setup") router.replace(setupFor(hereWithQuery()));
    else if (gate === "unlock") router.replace(`/unlock${next}`);
  }, [gate, router]);

  // Names are sealed: anything read before the unlock would come back, and stay, unnamed.
  if (gate !== "ready") return <BrandLoader className="mx-auto" />;
  return <ConsentForm fresh={me?.signIn.fresh ?? false} />;
}

function ConsentForm({ fresh }: { fresh: boolean }) {
  const memdot = useMemDot();
  const queryClient = useQueryClient();
  const oauthQuery = useSearchParams().toString();
  const spaces = useSpaces();
  const namespaces = useNamespaces();
  const [choice, setChoice] = useState<AccessChoice>(() => ({
    ...initialChoice(),
    newNamespaceMode: "assisted",
  }));
  const [busy, setBusy] = useState(false);

  // Everything shown here comes from what the OAuth server signed, not from this page's address.
  const request = useQuery({
    queryKey: ["oauth-request", oauthQuery],
    queryFn: () => memdot.agents.hostedRequest(oauthQuery),
    retry: false,
  });

  if (request.isPending) return <BrandLoader className="mx-auto" />;
  if (!request.data) {
    return (
      <ConsentHeader
        title="This link isn't valid"
        description="Nothing was connected. Start again from the app that asked."
      />
    );
  }

  const name = request.data.clientName ?? "An MCP client";
  const verifiedHost = identifiedBy(request.data.clientId);

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
          oauthQuery,
          role: choice.role,
          spaceIds: choice.spaceIds,
          namespaces: [...reachable, ...(made ? [{ id: made.id, name: made.name }] : [])],
          namespaceId,
          ...expiryDays(choice),
        });
      }
      window.location.assign(await memdot.agents.answerOAuth(oauthQuery, accept));
    } catch (error) {
      setBusy(false);
      toast.error(describeError(error).title);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <ConsentHeader
        title={`Connect ${name}`}
        {...(verifiedHost && RECOGNISED_HOSTS.has(verifiedHost) ? { client: name } : {})}
        description="It's asking to use your memories over MCP. It only gets what you choose here."
      />
      <ConsentFacts
        rows={[
          { label: "Calls itself", value: name },
          ...(verifiedHost ? [{ label: "Identified by", value: verifiedHost }] : []),
          { label: "Sends you back to", value: hostOf(request.data.redirectUri) },
          { label: "Reaches", value: "Assisted namespaces only" },
        ]}
      />
      <p className="-mt-3 text-center text-ui-sm text-text-3">
        {verifiedHost
          ? "If you didn't just add this, cancel."
          : "Anything can call itself anything. If you didn't just add this, cancel."}
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
