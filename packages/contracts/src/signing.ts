import { EVM_CHAIN_ID } from "@memdot/config";
import { encodeAbiParameters, type Hex, keccak256 } from "viem";

/**
 * Builds the exact bytes MemDotRegistry checks before a relayer-submitted action. Every helper
 * mirrors `keccak256(abi.encode("<action>", ...))` in the contract, argument for argument.
 */

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

const DOMAIN = "memdot/registry/v1";

const hashAction = (types: { type: string }[], values: unknown[]): Hex =>
  keccak256(encodeAbiParameters([{ type: "string" }, ...types], values as never));

export const actionHash = {
  registerKey: (encryptionKey: Hex, keyBundleHash: Hex) =>
    hashAction(
      [{ type: "bytes32" }, { type: "bytes32" }],
      ["registerKey", encryptionKey, keyBundleHash],
    ),
  deleteAccount: () => hashAction([], ["deleteAccount"]),
  createSpace: (salt: Hex, mode: number) =>
    hashAction([{ type: "bytes32" }, { type: "uint8" }], ["createSpace", salt, mode]),
  deleteSpace: (spaceId: Hex) => hashAction([{ type: "bytes32" }], ["deleteSpace", spaceId]),
  addObjects: (spaceId: Hex, contentHashes: Hex[], kinds: number[], sizes: bigint[]) =>
    hashAction(
      [{ type: "bytes32" }, { type: "bytes32[]" }, { type: "uint8[]" }, { type: "uint64[]" }],
      ["addObjects", spaceId, contentHashes, kinds, sizes],
    ),
  tombstoneObjects: (spaceId: Hex, contentHashes: Hex[]) =>
    hashAction(
      [{ type: "bytes32" }, { type: "bytes32[]" }],
      ["tombstoneObjects", spaceId, contentHashes],
    ),
  grant: (
    spaceId: Hex,
    objectHash: Hex,
    grantee: Hex,
    scope: number,
    expiresAt: bigint,
    wrappedKeyHash: Hex,
  ) =>
    hashAction(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint8" },
        { type: "uint64" },
        { type: "bytes32" },
      ],
      ["grant", spaceId, objectHash, grantee, scope, expiresAt, wrappedKeyHash],
    ),
  revokeGrant: (grantId: Hex) => hashAction([{ type: "bytes32" }], ["revokeGrant", grantId]),
  registerAgent: (agentKey: Hex) => hashAction([{ type: "bytes32" }], ["registerAgent", agentKey]),
  revokeAgent: (agentKey: Hex) => hashAction([{ type: "bytes32" }], ["revokeAgent", agentKey]),
};

/** Same bytes as `MemDotRegistry.signingMessage`; the owner signs these with sr25519. */
export function signingMessage(
  registry: Hex,
  owner: Hex,
  nonce: bigint,
  action: Hex,
  chainId: number = EVM_CHAIN_ID,
): Hex {
  return encodeAbiParameters(
    [
      { type: "string" },
      { type: "uint256" },
      { type: "address" },
      { type: "bytes32" },
      { type: "uint64" },
      { type: "bytes32" },
    ],
    [DOMAIN, BigInt(chainId), registry, owner, nonce, action],
  );
}
