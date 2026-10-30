"use client";

import { BrandLoader } from "@memdot/ui/components/brand";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { HOME, useGate } from "@/lib/session";

const ROUTE = { "sign-in": "/sign-in", setup: "/setup", unlock: "/unlock", ready: HOME } as const;

/** Sends each visitor where they stand until the landing page ships. */
export default function Home() {
  const router = useRouter();
  const { gate } = useGate();
  useEffect(() => {
    if (gate !== "loading") router.replace(ROUTE[gate]);
  }, [gate, router]);
  return (
    <main className="flex min-h-svh items-center justify-center">
      <BrandLoader />
    </main>
  );
}
