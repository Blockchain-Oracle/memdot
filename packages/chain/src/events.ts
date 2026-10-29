import { contentHash, toBytes, toHex } from "./cid.js";
import type { ChainClient } from "./client.js";

/** A TransactionStorage event: where an item now lives and which bytes it holds. */
export interface StorageEvent {
  kind: "stored" | "renewed";
  /** Index inside the block's TransactionStorage list; with the block it is the renew location. */
  index: number;
  contentHash: Uint8Array;
  /** Position of the extrinsic that caused it, when it came from one. */
  extrinsicIndex: number | null;
  /** The account that paid for that extrinsic (its signer), from TransactionFeePaid. */
  payer: string | null;
  feePlanck: bigint | null;
}

export async function blockHashOf(chain: ChainClient, block: number): Promise<string | null> {
  return chain.client._request<string | null, [number]>("chain_getBlockHash", [block]);
}

/**
 * Every TransactionStorage Stored/Renewed event in one block. Used to check a store a wallet
 * signed itself, and by the indexer to reconcile our records with the chain.
 */
export async function storageEventsAt(chain: ChainClient, block: number): Promise<StorageEvent[]> {
  const hash = await blockHashOf(chain, block);
  if (!hash) return [];
  const records = await chain.api.query.System.Events.getValue({ at: hash });
  const fees = new Map<number, { payer: string; fee: bigint }>();
  for (const record of records) {
    if (record.phase.type !== "ApplyExtrinsic") continue;
    if (record.event.type !== "TransactionPayment") continue;
    if (record.event.value.type !== "TransactionFeePaid") continue;
    const paid = record.event.value.value;
    fees.set(record.phase.value, { payer: paid.who, fee: paid.actual_fee });
  }
  const events: StorageEvent[] = [];
  for (const record of records) {
    if (record.event.type !== "TransactionStorage") continue;
    const inner = record.event.value;
    if (inner.type !== "Stored" && inner.type !== "Renewed") continue;
    const extrinsicIndex = record.phase.type === "ApplyExtrinsic" ? record.phase.value : null;
    const paid = extrinsicIndex === null ? undefined : fees.get(extrinsicIndex);
    events.push({
      kind: inner.type === "Stored" ? "stored" : "renewed",
      index: inner.value.index,
      contentHash: toBytes(inner.value.content_hash),
      extrinsicIndex,
      payer: paid?.payer ?? null,
      feePlanck: paid?.fee ?? null,
    });
  }
  return events;
}

/**
 * Hashes of every extrinsic in a block, as explorers show them (blake2b-256 of the encoded
 * extrinsic). Events only carry the extrinsic's position, so this maps them to a tx hash.
 */
export async function extrinsicHashes(chain: ChainClient, block: number): Promise<string[]> {
  const hash = await blockHashOf(chain, block);
  if (!hash) return [];
  const body = await chain.client._request<{ block: { extrinsics: string[] } }, [string]>(
    "chain_getBlock",
    [hash],
  );
  return body.block.extrinsics.map((ext) => toHex(contentHash(toBytes(ext))));
}
