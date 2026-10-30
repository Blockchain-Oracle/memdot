"use client";

import { BrandLoader } from "@memdot/ui/components/brand";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { OfflineState } from "@/components/offline-state";
import { HOME, useGate } from "@/lib/session";

const ROUTE = { "sign-in": "/sign-in", setup: "/setup", unlock: "/unlock", ready: HOME } as const;
type Routed = keyof typeof ROUTE;

/** Sends each visitor where they stand until the landing page ships. */
export default function Home() {
  const router = useRouter();
  const { gate, retry } = useGate();
  useEffect(() => {
    if (gate in ROUTE) router.replace(ROUTE[gate as Routed]);
  }, [gate, router]);
  if (gate === "offline") return <OfflineState onRetry={retry} />;
  return (
    <main className="flex min-h-svh items-center justify-center">
      <BrandLoader />
    </main>
  );
}
