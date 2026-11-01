import type { TxEvent, TxFinalizedPayload } from "polkadot-api";
import type { Observable } from "rxjs";
import { cidFromContentHash, contentHash, toBytes } from "./cid.js";
import type { PortaldotApi } from "./client.js";
import type { TxCreator } from "./signer.js";

/** Where an item currently lives; `renew` needs exactly this pair. */
export interface StorageLocation {
  block: number;
  /** Index inside the block's TransactionStorage list (from the event), not the extrinsic index. */
  index: number;
}

export type TxStage = "submitted" | "in-block" | "finalized";

export interface TxOptions {
  /** Explicit nonce lets the keeper queue several renewals without waiting a block each. */
  nonce?: number;
  onStage?: (stage: TxStage, detail: { txHash: string; block?: number }) => void;
}

export interface StoreResult {
  txHash: string;
  blockHash: string;
  location: StorageLocation;
  contentHash: Uint8Array;
  cid: string;
  /** What the signer actually paid (TransactionFeePaid), in planck. */
  feePlanck: bigint | null;
}

export interface RenewResult {
  txHash: string;
  blockHash: string;
  location: StorageLocation;
  contentHash: Uint8Array;
  feePlanck: bigint | null;
}

function feeOf(api: PortaldotApi, finalized: TxFinalizedPayload): bigint | null {
  return (
    api.event.TransactionPayment.TransactionFeePaid.filter(finalized.events)[0]?.payload
      .actual_fee ?? null
  );
}

interface Submittable {
  createSubmitAndWatch: (
    txCreator: TxCreator,
    txOptions?: { nonce?: number },
  ) => Observable<TxEvent>;
}

/** Submits a top-level extrinsic and resolves once it is finalized and succeeded. */
function submitFinalized(
  tx: Submittable,
  txCreator: TxCreator,
  options: TxOptions,
): Promise<TxFinalizedPayload> {
  const txOptions = options.nonce === undefined ? {} : { nonce: options.nonce };
  return new Promise((resolve, reject) => {
    const subscription = tx.createSubmitAndWatch(txCreator, txOptions).subscribe({
      next: (event) => {
        if (event.type === "broadcasted") options.onStage?.("submitted", { txHash: event.txHash });
        if (event.type === "inBestBlock") {
          options.onStage?.("in-block", { txHash: event.txHash, block: event.block.number });
        }
        if (event.type !== "finalized") return;
        subscription.unsubscribe();
        if (!event.ok) {
          reject(
            new Error(`extrinsic ${event.txHash} failed: ${JSON.stringify(event.dispatchError)}`),
          );
          return;
        }
        options.onStage?.("finalized", { txHash: event.txHash, block: event.block.number });
        resolve(event);
      },
      error: reject,
    });
  });
}

export interface ContractCallResult {
  txHash: string;
  block: number;
  feePlanck: bigint | null;
}

/** A contract rejected the call in its dry run, so nothing was submitted or paid. */
export class ContractRevertedError extends Error {}

const REVIVE_REVERT_FLAG = 1;
const WEIGHT_HEADROOM_PERCENT = 120n;

/**
 * Calls a Revive contract: dry-runs it, then submits with the measured weight and deposit. A revert
 * in the dry run throws ContractRevertedError before anything is signed.
 */
export async function callContract(
  api: PortaldotApi,
  txCreator: TxCreator,
  origin: string,
  contract: string,
  data: Uint8Array,
  options: TxOptions = {},
): Promise<ContractCallResult> {
  const dry = await api.apis.ReviveApi.call(
    origin,
    contract as never,
    0n,
    undefined,
    undefined,
    data,
  );
  if (!dry.result.success) {
    throw new ContractRevertedError(`dry run failed: ${JSON.stringify(dry.result.value)}`);
  }
  if (dry.result.value.flags & REVIVE_REVERT_FLAG) {
    throw new ContractRevertedError("the contract reverted");
  }
  const finalized = await submitFinalized(
    api.tx.Revive.call({
      dest: contract as never,
      value: 0n,
      weight_limit: {
        ref_time: (dry.weight_required.ref_time * WEIGHT_HEADROOM_PERCENT) / 100n,
        proof_size: (dry.weight_required.proof_size * WEIGHT_HEADROOM_PERCENT) / 100n,
      },
      storage_deposit_limit:
        dry.max_storage_deposit.type === "Charge" ? dry.max_storage_deposit.value : 0n,
      data,
    }),
    txCreator,
    options,
  );
  return {
    txHash: finalized.txHash,
    block: finalized.block.number,
    feePlanck: feeOf(api, finalized),
  };
}

/** Stores one chunk with `TransactionStorage.store`. Never wrap this call (batch, proxy, EVM). */
export async function storeChunk(
  api: PortaldotApi,
  txCreator: TxCreator,
  data: Uint8Array,
  options: TxOptions = {},
): Promise<StoreResult> {
  const expectedHash = contentHash(data);
  const finalized = await submitFinalized(
    api.tx.TransactionStorage.store({ data }),
    txCreator,
    options,
  );
  const [stored] = api.event.TransactionStorage.Stored.filter(finalized.events);
  if (!stored) throw new Error(`no Stored event in ${finalized.txHash}`);
  const hash = toBytes(stored.payload.content_hash);
  if (!hash.every((byte, i) => byte === expectedHash[i])) {
    throw new Error(`chain recorded a different content hash for ${finalized.txHash}`);
  }
  return {
    txHash: finalized.txHash,
    blockHash: finalized.block.hash,
    location: { block: finalized.block.number, index: stored.payload.index },
    contentHash: hash,
    cid: cidFromContentHash(hash),
    feePlanck: feeOf(api, finalized),
  };
}

/** Renews an item: same content hash and CID, new location to track. Never batch renewals. */
export async function renew(
  api: PortaldotApi,
  txCreator: TxCreator,
  location: StorageLocation,
  options: TxOptions = {},
): Promise<RenewResult> {
  const finalized = await submitFinalized(
    api.tx.TransactionStorage.renew(location),
    txCreator,
    options,
  );
  const [renewed] = api.event.TransactionStorage.Renewed.filter(finalized.events);
  if (!renewed) throw new Error(`no Renewed event in ${finalized.txHash}`);
  return {
    txHash: finalized.txHash,
    blockHash: finalized.block.hash,
    location: { block: finalized.block.number, index: renewed.payload.index },
    contentHash: toBytes(renewed.payload.content_hash),
    feePlanck: feeOf(api, finalized),
  };
}
