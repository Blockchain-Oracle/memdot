import { Wordmark } from "@memdot/ui/components/brand";
import Link from "next/link";

/** The frame for sign-in, unlock and recovery: the mark, one centered card, the chain it runs on. */
export function AuthFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col">
      <header className="flex h-14 items-center justify-between px-4 sm:px-6">
        <Link
          href="/"
          className="rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <Wordmark />
        </Link>
      </header>
      <main className="flex flex-1 items-start justify-center px-4 pt-[8vh] pb-16 sm:items-center sm:pt-0">
        <div className="w-full max-w-[400px]">{children}</div>
      </main>
      <footer className="flex h-12 items-center justify-center gap-2 px-4 text-ui-sm text-text-3">
        <span className="size-1.5 rounded-full bg-ember" aria-hidden="true" />
        Built on Portaldot V3
      </footer>
    </div>
  );
}

/** A divider with a word in it ("or use a wallet"). */
export function OrDivider({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-1">
      <span className="h-px flex-1 bg-border" />
      <span className="eyebrow">{children}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
