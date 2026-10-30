"use client";

import { publicKeyOf, toBytes } from "@memdot/chain";
import { EVM_ACCOUNT_SUFFIX } from "@memdot/config";
import type { Recipient } from "@memdot/sdk";
import { Identicon } from "@memdot/ui/components/identicon";
import { Input } from "@memdot/ui/components/input";
import { Spinner } from "@memdot/ui/components/spinner";
import { cn } from "@memdot/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { CircleCheckIcon, ClockIcon } from "lucide-react";
import { useDeferredValue } from "react";
import { useMemDot } from "@/lib/memdot";

const H160 = /^0x[0-9a-fA-F]{40}$/;

/** The account id behind what was typed (SS58 or an EVM address), or null while invalid. */
export function accountIdOf(value: string): Uint8Array | null {
  const input = value.trim();
  if (H160.test(input)) return toBytes(`${input.toLowerCase()}${EVM_ACCOUNT_SUFFIX}`);
  try {
    return publicKeyOf(input);
  } catch {
    return null;
  }
}

/**
 * A Substrate (SS58) or EVM address with its identicon, checked as you type: does it have a
 * MemDot sharing key yet?
 */
export function AddressInput({
  id,
  value,
  onChange,
  onRecipient,
}: {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  onRecipient?: (recipient: Recipient | null) => void;
}) {
  const memdot = useMemDot();
  const deferred = useDeferredValue(value.trim());
  const accountId = accountIdOf(deferred);
  const recipient = useQuery({
    queryKey: ["recipient", deferred],
    enabled: accountId !== null,
    queryFn: async () => {
      const result = await memdot.sharing.recipient(deferred);
      onRecipient?.(result);
      return result;
    },
    staleTime: 60_000,
  });
  const invalid = deferred.length > 0 && accountId === null;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative">
        <span className="absolute top-1/2 left-2.5 -translate-y-1/2">
          {accountId ? (
            <Identicon publicKey={accountId} size={20} />
          ) : (
            <span className="block size-5 rounded-full border border-dashed border-border-strong" />
          )}
        </span>
        <Input
          id={id}
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
            onRecipient?.(null);
          }}
          placeholder="5Grw… or 0x… address"
          spellCheck={false}
          autoComplete="off"
          aria-invalid={invalid || undefined}
          className="h-10 pl-10 font-mono text-mono"
        />
      </div>
      <p
        className={cn(
          "flex items-center gap-1.5 text-ui-sm",
          invalid ? "text-danger-fg" : "text-text-3",
          recipient.data?.registered && "text-ok-fg",
        )}
      >
        {invalid ? (
          "That is not a Substrate or EVM address."
        ) : !accountId ? (
          "Their MemDot address: Substrate (SS58) or EVM."
        ) : recipient.isPending ? (
          <>
            <Spinner className="size-3.5" /> Looking up their sharing key…
          </>
        ) : recipient.data?.registered ? (
          <>
            <CircleCheckIcon className="size-3.5" /> Has a MemDot key. They can open it right away.
          </>
        ) : (
          <>
            <ClockIcon className="size-3.5" /> No MemDot key yet. The share waits and completes when
            they sign up and you next unlock.
          </>
        )}
      </p>
    </div>
  );
}
