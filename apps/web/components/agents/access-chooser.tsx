"use client";

import type { MemoryMode, Namespace, Space } from "@memdot/sdk";
import { Checkbox } from "@memdot/ui/components/checkbox";
import { Input } from "@memdot/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@memdot/ui/components/select";
import Link from "next/link";
import { useId } from "react";
import type { ROLES } from "@/components/keys/role-choice";
import { RoleChoice } from "@/components/keys/role-choice";
import { ModeBadge } from "@/components/memory/mode-badge";
import { hereWithQuery, setupFor } from "@/lib/session";

const NEW_NAMESPACE = "new";
const NAMESPACE_MAX = 64;
const NEVER = "never";
const AGENT_ROLES: typeof ROLES = [
  {
    value: "read_write",
    title: "Read and write",
    description: "Remember and forget, store and delete, in these spaces.",
  },
  { value: "read_only", title: "Read only", description: "Search, read and verify. No changes." },
];
/** A hosted agent holds no key, so it can't touch files. */
const HOSTED_ROLES: typeof ROLES = [
  { value: "read_write", title: "Read and write", description: "Search, remember and forget." },
  { value: "read_only", title: "Read only", description: "Search and read. No changes." },
];
const EXPIRES = [
  { value: "30", label: "In 30 days" },
  { value: "90", label: "In 90 days" },
  { value: "365", label: "In a year" },
  { value: NEVER, label: "Never" },
];

export interface AccessChoice {
  spaceIds: string[];
  role: "read_write" | "read_only";
  /** An existing namespace, or `NEW_NAMESPACE`; null when there's nowhere to put memories yet. */
  namespaceId: string | null;
  newNamespaceName: string;
  newNamespaceMode: MemoryMode;
  expires: string;
}

export const initialChoice = (): AccessChoice => ({
  spaceIds: [],
  role: "read_write",
  namespaceId: null,
  newNamespaceName: "Agent memory",
  newNamespaceMode: "private",
  expires: "90",
});

/** The default expiry as days, or nothing for a connection that doesn't expire. */
export const expiryDays = (choice: AccessChoice) =>
  choice.expires === NEVER ? {} : { expiresInDays: Number(choice.expires) };

export const makesNamespace = (choice: AccessChoice) => choice.namespaceId === NEW_NAMESPACE;

/** Whether what's chosen is enough to go ahead. */
export function complete(choice: AccessChoice, hosted: boolean): boolean {
  if (choice.spaceIds.length === 0) return false;
  if (makesNamespace(choice)) return choice.newNamespaceName.trim().length > 0;
  return !hosted || Boolean(choice.namespaceId);
}

/**
 * What an agent gets. A space is the smallest thing its keys can be given for, so the choice is
 * made per space and says so. A hosted agent holds no key, so it only sees Assisted namespaces.
 */
export function AccessChooser({
  spaces,
  namespaces,
  hosted,
  value,
  onChange,
}: {
  spaces: Space[];
  namespaces: Namespace[];
  hosted: boolean;
  value: AccessChoice;
  onChange: (next: AccessChoice) => void;
}) {
  const id = useId();
  const usable = (namespace: Namespace) => !hosted || namespace.mode === "assisted";
  // MemDot stores Assisted segments itself, and it can't sign with someone's wallet.
  const reachable = hosted
    ? spaces.filter(
        (space) =>
          space.mode === "sponsored" ||
          namespaces.some((row) => row.spaceId === space.id && usable(row)),
      )
    : spaces;
  const chosenNamespaces = namespaces.filter(
    (row) => value.spaceIds.includes(row.spaceId) && usable(row),
  );
  const firstChosen = spaces.find((space) => value.spaceIds.includes(space.id));

  const toggle = (spaceId: string, on: boolean) => {
    const spaceIds = on
      ? [...value.spaceIds, spaceId]
      : value.spaceIds.filter((other) => other !== spaceId);
    const stillThere = namespaces.some(
      (row) => row.id === value.namespaceId && spaceIds.includes(row.spaceId) && usable(row),
    );
    const firstNamespace = namespaces.find((row) => spaceIds.includes(row.spaceId) && usable(row));
    onChange({
      ...value,
      spaceIds,
      namespaceId: stillThere
        ? value.namespaceId
        : (firstNamespace?.id ?? (spaceIds.length ? NEW_NAMESPACE : null)),
    });
  };

  return (
    <div className="flex flex-col gap-5">
      <fieldset className="flex flex-col gap-2">
        <legend className="eyebrow mb-1">What it can reach</legend>
        {reachable.length === 0 ? (
          <p className="rounded-xl border border-border bg-surface-1 p-4 text-ui-sm text-text-2">
            {spaces.length > 0
              ? "A hosted connection needs a sponsored space. Your spaces are all self-signed. "
              : "You have no spaces yet. "}
            {/* It comes straight back here: the request is still waiting. */}
            <Link
              href={setupFor(hereWithQuery())}
              className="font-medium text-foreground underline"
            >
              Create one
            </Link>
          </p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-border bg-surface-1">
            {reachable.map((space) => {
              const inSpace = namespaces.filter((row) => row.spaceId === space.id);
              return (
                <label
                  key={space.id}
                  htmlFor={`${id}-${space.id}`}
                  className="flex cursor-pointer gap-3 border-b border-border p-3 last:border-0 hover:bg-surface-2/60"
                >
                  <Checkbox
                    id={`${id}-${space.id}`}
                    className="mt-0.5"
                    checked={value.spaceIds.includes(space.id)}
                    onCheckedChange={(on) => toggle(space.id, on === true)}
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <span className="truncate text-ui font-medium">
                      {space.name ?? "Unnamed space"}
                    </span>
                    {inSpace.length > 0 && (
                      <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        {inSpace.map((row) => (
                          <span
                            key={row.id}
                            className={`flex items-center gap-1.5 text-ui-sm ${usable(row) ? "text-text-2" : "text-text-4"}`}
                          >
                            {row.name ?? "Namespace"}
                            <ModeBadge mode={row.mode} />
                          </span>
                        ))}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>
        )}
        <p className="text-ui-sm text-text-3">
          {hosted
            ? "It reaches Assisted namespaces in these spaces, and not their files. Private ones stay out of reach: only a device with its own key can open them."
            : "It can read everything in a space you tick: its files and its namespaces. Keys are per space, so use a separate space for what it shouldn't see."}
        </p>
      </fieldset>

      {value.spaceIds.length > 0 && (
        <div className="flex flex-col gap-2">
          <label htmlFor={`${id}-namespace`} className="eyebrow">
            Where it remembers
          </label>
          <Select
            value={value.namespaceId ?? undefined}
            onValueChange={(namespaceId) => onChange({ ...value, namespaceId })}
          >
            <SelectTrigger id={`${id}-namespace`} className="w-full">
              <SelectValue placeholder="Choose a namespace" />
            </SelectTrigger>
            <SelectContent>
              {chosenNamespaces.map((row) => (
                <SelectItem key={row.id} value={row.id}>
                  {row.name ?? "Namespace"} · {row.mode === "private" ? "Private" : "Assisted"}
                </SelectItem>
              ))}
              <SelectItem value={NEW_NAMESPACE}>New namespace…</SelectItem>
            </SelectContent>
          </Select>
          {makesNamespace(value) && (
            <div className="flex flex-col gap-2 rounded-xl border border-border bg-surface-1 p-3">
              <Input
                aria-label="Name of the new namespace"
                value={value.newNamespaceName}
                maxLength={NAMESPACE_MAX}
                onChange={(event) => onChange({ ...value, newNamespaceName: event.target.value })}
              />
              {!hosted && firstChosen?.mode === "sponsored" && (
                <Select
                  value={value.newNamespaceMode}
                  onValueChange={(mode) =>
                    onChange({ ...value, newNamespaceMode: mode as MemoryMode })
                  }
                >
                  <SelectTrigger aria-label="Mode of the new namespace" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="private">
                      Private: only devices with the key read it
                    </SelectItem>
                    <SelectItem value="assisted">
                      Assisted: the server reads text to extract
                    </SelectItem>
                  </SelectContent>
                </Select>
              )}
              <p className="text-ui-sm text-text-3">
                It goes in {firstChosen?.name ?? "the first space you ticked"}. Its mode can't
                change later.
              </p>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-col gap-2">
        <span className="eyebrow">What it can do</span>
        <RoleChoice
          value={value.role}
          roles={hosted ? HOSTED_ROLES : AGENT_ROLES}
          onChange={(role) => onChange({ ...value, role: role as AccessChoice["role"] })}
        />
      </div>

      <div className="flex flex-col gap-2">
        <label htmlFor={`${id}-expires`} className="eyebrow">
          When it stops working
        </label>
        <Select value={value.expires} onValueChange={(expires) => onChange({ ...value, expires })}>
          <SelectTrigger id={`${id}-expires`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EXPIRES.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
