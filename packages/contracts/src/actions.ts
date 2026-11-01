import { decodeAbiParameters, encodeAbiParameters, type Hex, pad } from "viem";

/**
 * What a `Recorded` event means. The contract only checks the owner's signature and logs `action`
 * and `data`; these codecs are the record format every reader and writer shares. Add new kinds at
 * the end: the numbers are permanent, and logged records are never rewritten.
 */
export const Action = {
  RegisterKey: 0,
  DeleteAccount: 1,
  CreateSpace: 2,
  DeleteSpace: 3,
  AddObjects: 4,
  TombstoneObjects: 5,
  Grant: 6,
  RevokeGrant: 7,
  RegisterAgent: 8,
  RevokeAgent: 9,
} as const;

export const SpaceMode = { Sponsored: 0, SelfSigned: 1 } as const;
export const ObjectKind = {
  File: 0,
  Manifest: 1,
  Segment: 2,
  IndexSnapshot: 3,
  KeyBundle: 4,
  GrantKey: 5,
} as const;
export const Scope = { Read: 0, ReadWrite: 1 } as const;

const SCHEMAS = {
  [Action.RegisterKey]: [
    { name: "encryptionKey", type: "bytes32" },
    { name: "keyBundleHash", type: "bytes32" },
  ],
  [Action.DeleteAccount]: [],
  [Action.CreateSpace]: [{ name: "mode", type: "uint8" }],
  [Action.DeleteSpace]: [],
  [Action.AddObjects]: [
    { name: "contentHashes", type: "bytes32[]" },
    { name: "kinds", type: "uint8[]" },
    { name: "sizes", type: "uint64[]" },
  ],
  [Action.TombstoneObjects]: [{ name: "contentHashes", type: "bytes32[]" }],
  [Action.Grant]: [
    { name: "grantId", type: "bytes32" },
    { name: "objectHash", type: "bytes32" },
    { name: "grantee", type: "bytes32" },
    { name: "scope", type: "uint8" },
    { name: "expiresAt", type: "uint64" },
    { name: "wrappedKeyHash", type: "bytes32" },
  ],
  [Action.RevokeGrant]: [{ name: "grantId", type: "bytes32" }],
  [Action.RegisterAgent]: [{ name: "agentKey", type: "bytes32" }],
  [Action.RevokeAgent]: [{ name: "agentKey", type: "bytes32" }],
} as const;

const NAMES = Object.fromEntries(Object.entries(Action).map(([name, id]) => [id, name])) as Record<
  number,
  keyof typeof Action
>;

/** Zero salt: a record about the account itself, in no space. */
export const NO_SALT: Hex = `0x${"00".repeat(32)}`;

/** A MemDot uuid (space, grant) as bytes32, reversible so records map back to their rows. */
export const uuidToBytes32 = (id: string): Hex => pad(`0x${id.replaceAll("-", "")}`, { size: 32 });

export function bytes32ToUuid(value: Hex): string {
  const hex = value.slice(-32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A record's human name, or null for a kind this reader does not know yet. */
export const actionName = (action: number): keyof typeof Action | null => NAMES[action] ?? null;

export const encodeRecord = {
  registerKey: (encryptionKey: Hex, keyBundleHash: Hex) =>
    encodeAbiParameters(SCHEMAS[Action.RegisterKey], [encryptionKey, keyBundleHash]),
  deleteAccount: (): Hex => "0x",
  createSpace: (mode: number) => encodeAbiParameters(SCHEMAS[Action.CreateSpace], [mode]),
  deleteSpace: (): Hex => "0x",
  addObjects: (contentHashes: Hex[], kinds: number[], sizes: bigint[]) =>
    encodeAbiParameters(SCHEMAS[Action.AddObjects], [contentHashes, kinds, sizes]),
  tombstoneObjects: (contentHashes: Hex[]) =>
    encodeAbiParameters(SCHEMAS[Action.TombstoneObjects], [contentHashes]),
  grant: (
    grantId: Hex,
    objectHash: Hex,
    grantee: Hex,
    scope: number,
    expiresAt: bigint,
    wrappedKeyHash: Hex,
  ) =>
    encodeAbiParameters(SCHEMAS[Action.Grant], [
      grantId,
      objectHash,
      grantee,
      scope,
      expiresAt,
      wrappedKeyHash,
    ]),
  revokeGrant: (grantId: Hex) => encodeAbiParameters(SCHEMAS[Action.RevokeGrant], [grantId]),
  registerAgent: (agentKey: Hex) => encodeAbiParameters(SCHEMAS[Action.RegisterAgent], [agentKey]),
  revokeAgent: (agentKey: Hex) => encodeAbiParameters(SCHEMAS[Action.RevokeAgent], [agentKey]),
};

/** The named fields of a record, or null when its action is unknown or its data is malformed. */
export function decodeRecord(action: number, data: Hex): Record<string, unknown> | null {
  const schema = SCHEMAS[action as keyof typeof SCHEMAS];
  if (!schema) return null;
  try {
    const values = schema.length === 0 ? [] : decodeAbiParameters(schema, data);
    return Object.fromEntries(schema.map((field, i) => [field.name, values[i]]));
  } catch {
    return null;
  }
}
