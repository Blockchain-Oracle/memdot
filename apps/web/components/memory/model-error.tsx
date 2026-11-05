"use client";

import { MemDotError } from "@memdot/sdk";
import Link from "next/link";
import { describeError } from "@/lib/errors";

/** useChat hands back a failed request's body as its message, so the real one is inside it. */
function textOf(error: unknown): string {
  const { title } = describeError(error);
  try {
    const body = JSON.parse(title) as { error?: { message?: string }; message?: string };
    return body.error?.message ?? body.message ?? title;
  } catch {
    return title;
  }
}

/** Why a model call didn't happen, with the way to fix it when that's setting one up. */
export function ModelError({ error }: { error: unknown }) {
  const text = textOf(error);
  const needsModel =
    (error instanceof MemDotError && error.code === "MODEL_REQUIRED") || /set a model/i.test(text);
  return (
    <p className="text-ui-sm text-danger-fg">
      {text}{" "}
      {needsModel && (
        <Link href="/configuration" className="underline underline-offset-4">
          Open Configuration
        </Link>
      )}
    </p>
  );
}
