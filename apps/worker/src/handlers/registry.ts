import { transfer } from "@memdot/chain";
import { EVM_ACCOUNT_SUFFIX, EVM_DECIMALS, TPOT_DECIMALS } from "@memdot/config";
import type { RegistryPayload } from "@memdot/jobs";
import { BaseError, type Hex, hexToBytes } from "viem";
import type { Deps } from "../deps.js";

/** JSON-RPC error code for "execution reverted". */
const REVERTED_CODE = 3;
const RECEIPT_TIMEOUT_MS = 120_000;
const TOP_UP_BELOW_TPOT = 2n;
const TOP_UP_TPOT = 25n;

const isRevert = (error: unknown) =>
  error instanceof BaseError &&
  error.walk((cause) => (cause as { code?: unknown }).code === REVERTED_CODE) !== null;

/**
 * Keeps the EVM account funded from the relayer. This runs inside a chain-tx job, and that queue
 * runs one job at a time, so the transfer cannot collide with another relayer transaction.
 */
async function topUp(deps: Deps): Promise<void> {
  const { account, publicClient } = deps.evm;
  const balance = await publicClient.getBalance({ address: account.address });
  if (balance >= TOP_UP_BELOW_TPOT * 10n ** BigInt(EVM_DECIMALS)) return;
  const accountId = hexToBytes(`${account.address.toLowerCase()}${EVM_ACCOUNT_SUFFIX}` as Hex);
  await transfer(
    deps.chain.api,
    deps.signer.txCreator,
    accountId,
    TOP_UP_TPOT * 10n ** BigInt(TPOT_DECIMALS),
  );
  console.log(`[registry] topped up ${account.address} with ${TOP_UP_TPOT} tPOT`);
}

/**
 * Submits one owner-signed registry record as an EVM transaction. The contract checks the
 * signature, so a bad one reverts in gas estimation: that costs nothing and can never succeed, so
 * it is dropped instead of retried. A retry after a lost receipt is harmless, because readers
 * apply each (owner, nonce) pair once.
 */
export async function handleRegistry(deps: Deps, payload: RegistryPayload): Promise<void> {
  const { account, publicClient, walletClient } = deps.evm;
  const to = deps.env.REGISTRY_ADDRESS as Hex;
  const data = payload.calldata as Hex;
  let gas: bigint;
  try {
    gas = await publicClient.estimateGas({ account, to, data });
  } catch (error) {
    if (!isRevert(error)) throw error;
    console.warn("[registry] dropped a record the contract rejected");
    return;
  }
  await topUp(deps);
  const hash = await walletClient.sendTransaction({ to, data, gas });
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    timeout: RECEIPT_TIMEOUT_MS,
  });
  console.log(`[registry] ${receipt.status} in #${receipt.blockNumber} ${hash}`);
}
