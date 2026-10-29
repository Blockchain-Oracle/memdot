// Writes test/signing-vectors.json from the TypeScript signing helpers. The Foundry test checks
// the contract produces the same bytes, so a client signature always matches what it verifies.
import { writeFile } from "node:fs/promises";
import { EVM_CHAIN_ID } from "@memdot/config";
import { type Hex, keccak256 } from "viem";
import { actionHash, SpaceMode, signingMessage } from "../src/signing.js";

const registry: Hex = "0x000000000000000000000000000000000000abcd";
const owner: Hex = "0x1111111111111111111111111111111111111111111111111111111111111111";
const salt: Hex = "0x2222222222222222222222222222222222222222222222222222222222222222";
const nonce = 7n;

const action = actionHash.createSpace(salt, SpaceMode.SelfSigned);
const message = signingMessage(registry, owner, nonce, action, EVM_CHAIN_ID);

const vectors = {
  registry,
  chainId: EVM_CHAIN_ID,
  owner,
  salt,
  mode: SpaceMode.SelfSigned,
  nonce: Number(nonce),
  actionHash: action,
  messageHash: keccak256(message),
};
await writeFile(
  new URL("../test/signing-vectors.json", import.meta.url),
  `${JSON.stringify(vectors, null, 2)}\n`,
);
console.log("Wrote test/signing-vectors.json");
