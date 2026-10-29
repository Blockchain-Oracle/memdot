import { toBytes } from "./cid.js";
import type { ChainClient } from "./client.js";

/** A TransactionStorage event: where an item now lives and which bytes it holds. */
export interface StorageEvent {
  kind: "stored" | "renewed";
  /** Index inside the block's TransactionStorage list; with the block it is the renew location. */
  index: number;
  contentHash: Uint8Array;
  /** Position of the extrinsic that caused it, when it came from one. */
  extrinsicIndex: number | null;
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
  const events: StorageEvent[] = [];
  for (const record of records) {
    if (record.event.type !== "TransactionStorage") continue;
    const inner = record.event.value;
    if (inner.type !== "Stored" && inner.type !== "Renewed") continue;
    events.push({
      kind: inner.type === "Stored" ? "stored" : "renewed",
      index: inner.value.index,
      contentHash: toBytes(inner.value.content_hash),
      extrinsicIndex: record.phase.type === "ApplyExtrinsic" ? record.phase.value : null,
    });
  }
  return events;
}
