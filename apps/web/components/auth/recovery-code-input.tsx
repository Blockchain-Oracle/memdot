"use client";

import { isValidRecoveryCode, normalizeRecoveryCode } from "@memdot/sdk";
import { Button } from "@memdot/ui/components/button";
import { Label } from "@memdot/ui/components/label";
import { Spinner } from "@memdot/ui/components/spinner";
import { Textarea } from "@memdot/ui/components/textarea";
import { useId, useState } from "react";

/** Entry for the 12-word recovery code, checked locally (checksum) before anything is sent. */
export function RecoveryCodeInput({
  label = "Recovery code",
  action,
  onSubmit,
}: {
  label?: string;
  action: string;
  onSubmit: (code: string) => Promise<void>;
}) {
  const id = useId();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const words = value.trim().split(/\s+/).filter(Boolean).length;

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={async (event) => {
        event.preventDefault();
        const code = normalizeRecoveryCode(value);
        if (!isValidRecoveryCode(code)) {
          setError("That is not a valid recovery code. Check the words and their order.");
          return;
        }
        setError(null);
        setBusy(true);
        try {
          await onSubmit(code);
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : "That code did not work.");
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="flex items-baseline justify-between">
        <Label htmlFor={id}>{label}</Label>
        <span className="font-mono text-ui-sm text-text-3 tabular">{words}/12 words</span>
      </div>
      <Textarea
        id={id}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="twelve words separated by spaces"
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="none"
        rows={3}
        aria-invalid={error ? true : undefined}
        className="font-mono text-mono"
      />
      {error && <p className="text-ui-sm text-danger-fg">{error}</p>}
      <Button type="submit" size="lg" className="h-10" disabled={busy || words < 12}>
        {busy && <Spinner data-icon="inline-start" />}
        {action}
      </Button>
    </form>
  );
}
