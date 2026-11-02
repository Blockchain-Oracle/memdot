"use client";

import { BrandLoader } from "@memdot/ui/components/brand";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { AuthFrame } from "@/components/auth/auth-frame";
import { API_URL } from "@/lib/env";
import { hereWithQuery, setupFor, useGate } from "@/lib/session";

/** Added by the OAuth server to sign what it sends here; a fresh request gets its own. */
const SIGNING_PARAMS = ["sig", "exp", "ba_iat", "ba_param", "ba_pl"];

/**
 * Where the OAuth server sends someone with no session. Sign-in happens on the usual page, then
 * the same request goes back to the server, which now knows who's asking.
 */
export default function OAuthSignInPage() {
  const { gate } = useGate();
  const router = useRouter();

  useEffect(() => {
    if (gate === "loading" || gate === "offline") return;
    if (gate === "sign-in") {
      router.replace(`/sign-in?next=${encodeURIComponent(hereWithQuery())}`);
      return;
    }
    if (gate === "setup") {
      router.replace(setupFor(hereWithQuery()));
      return;
    }
    const request = new URLSearchParams(window.location.search);
    for (const name of SIGNING_PARAMS) request.delete(name);
    // Asked for rather than navigated to: a full page load would forget the key just unlocked, and
    // ask for the passkey a second time.
    void fetch(`${API_URL}/api/auth/oauth2/authorize?${request}`, {
      credentials: "include",
      headers: { accept: "application/json" },
    })
      .then((response) => response.json() as Promise<{ url?: string }>)
      .then(({ url }) => {
        if (!url) throw new Error("no redirect");
        const next = new URL(url);
        if (next.origin === window.location.origin)
          router.replace(`${next.pathname}${next.search}`);
        else window.location.assign(url);
      })
      .catch(() => window.location.replace(`${API_URL}/api/auth/oauth2/authorize?${request}`));
  }, [gate, router]);

  return (
    <AuthFrame>
      <BrandLoader className="mx-auto" />
    </AuthFrame>
  );
}
