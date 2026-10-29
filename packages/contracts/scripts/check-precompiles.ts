// Read-only check that the V3 System precompile behaves as the registry assumes: blake2-256
// hashing and sr25519 signature verification. No funds needed (eth_call only).
import { existsSync } from "node:fs";
import { contentHash, signerFromMnemonic, toHex } from "@memdot/chain";
import { PORTALDOT_EVM_RPC } from "@memdot/config";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { entropyToMiniSecret, mnemonicToEntropy } from "@polkadot-labs/hdkd-helpers";
import {
  createPublicClient,
  decodeFunctionResult,
  encodeFunctionData,
  http,
  parseAbi,
  toBytes,
} from "viem";

const SYSTEM = "0x0000000000000000000000000000000000000900";
const abi = parseAbi([
  "function hashBlake256(bytes input) pure returns (bytes32)",
  "function sr25519Verify(uint8[64] signature, bytes message, bytes32 publicKey) view returns (bool)",
]);

const envUrl = new URL("../../../.env", import.meta.url);
if (existsSync(envUrl)) process.loadEnvFile(envUrl);
const mnemonic = process.env.SIGNER_MNEMONIC;
if (!mnemonic) throw new Error("SIGNER_MNEMONIC is not set in .env");

const client = createPublicClient({ transport: http(PORTALDOT_EVM_RPC) });
const call = async <F extends "hashBlake256" | "sr25519Verify">(
  functionName: F,
  args: readonly unknown[],
) => {
  const data = encodeFunctionData({ abi, functionName, args } as never);
  const { data: out } = await client.call({ to: SYSTEM, data });
  if (!out) throw new Error(`${functionName} returned no data`);
  return decodeFunctionResult({ abi, functionName, data: out } as never);
};

const message = toBytes("memdot/registry/v1 precompile check");
const onChainHash = await call("hashBlake256", [toHex(message)]);
console.log(
  `hashBlake256 matches local blake2b-256: ${onChainHash === toHex(contentHash(message))}`,
);

const keyPair = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(mnemonic)))("");
const signature = Array.from(keyPair.sign(message));
const publicKey = toHex(signerFromMnemonic(mnemonic).publicKey);
const valid = await call("sr25519Verify", [signature, toHex(message), publicKey]);
const tampered = await call("sr25519Verify", [
  signature,
  toHex(toBytes("something else")),
  publicKey,
]);
console.log(
  `sr25519Verify accepts a real signature: ${valid} · rejects a wrong message: ${!tampered}`,
);
