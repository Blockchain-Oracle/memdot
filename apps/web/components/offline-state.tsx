import { Button } from "@memdot/ui/components/button";
import { CloudOffIcon } from "lucide-react";
import { API_URL } from "@/lib/env";

/** MemDot's API cannot be reached. Keys and files on this device are untouched. */
export function OfflineState({ onRetry }: { onRetry: () => void }) {
  return (
    <main className="flex min-h-svh items-center justify-center px-4">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        <CloudOffIcon className="size-6 text-text-3" aria-hidden="true" />
        <div className="flex flex-col gap-1.5">
          <h1 className="text-h2">MemDot's API is not reachable</h1>
          <p className="text-ui text-text-2">
            Nothing on this device changed. Your files stay on Portaldot either way.
          </p>
          <p className="font-mono text-ui-sm text-text-3">{API_URL}</p>
        </div>
        <Button onClick={onRetry}>Try again</Button>
      </div>
    </main>
  );
}
