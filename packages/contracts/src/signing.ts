import { EVM_CHAIN_ID } from "@memdot/config";
import { encodeAbiParameters, type Hex, keccak256 } from "viem";

const DOMAIN = "memdot/registry/v1";

/** The hash an owner authorizes: `keccak256(abi.encode(salt, action, keccak256(data)))`. */
export const actionHash = (salt: Hex, action: number, data: Hex): Hex =>
  keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint8" }, { type: "bytes32" }],
      [salt, action, keccak256(data)],
    ),
  );

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
