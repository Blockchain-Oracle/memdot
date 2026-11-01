import { Wordmark } from "@memdot/ui/components/brand";
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Proof",
  description: "Where MemDot data lives on Portaldot V3, checked by your own browser.",
};

/** Public proof pages: anyone can check where encrypted MemDot data lives on Portaldot V3. */
export default function ProofLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col">
      <header className="flex h-14 items-center justify-between border-b border-border px-4 sm:px-6">
        <Link
          href="/"
          className="rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <Wordmark />
        </Link>
        <Link
          href="/proof/registry"
          className="flex items-center gap-2 rounded-lg text-ui-sm text-text-3 outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <span className="size-1.5 rounded-full bg-ember" aria-hidden="true" />
          Registry on Portaldot V3
        </Link>
      </header>
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-4 py-8 sm:px-6">
        {children}
      </main>
    </div>
  );
}
