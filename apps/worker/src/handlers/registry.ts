import { ContractRevertedError, callContract } from "@memdot/chain";
import type { RegistryPayload } from "@memdot/jobs";
import { hexToBytes } from "viem";
import type { Deps } from "../deps.js";

/**
 * Submits one owner-signed registry record. The contract checks the signature, so a bad one fails
 * in the dry run: that costs nothing and can never succeed, so it is dropped instead of retried.
 */
export async function handleRegistry(deps: Deps, payload: RegistryPayload): Promise<void> {
  try {
    const result = await callContract(
      deps.chain.api,
      deps.signer.txCreator,
      deps.signer.address,
      deps.env.REGISTRY_ADDRESS,
      hexToBytes(payload.calldata as `0x${string}`),
    );
    console.log(`[registry] recorded in #${result.block} ${result.txHash}`);
  } catch (error) {
    if (!(error instanceof ContractRevertedError)) throw error;
    console.warn(`[registry] dropped a record: ${error.message}`);
  }
}
