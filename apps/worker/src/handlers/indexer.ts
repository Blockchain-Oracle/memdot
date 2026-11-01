import { extrinsicHashes, type StorageEvent, storageEventsAt, toHex } from "@memdot/chain";
import { actionName, decodeRecord, memDotRegistryAbi } from "@memdot/contracts";
import { blobStaging, chainCursors, chainEvents, renewals, storedItems } from "@memdot/db";
import { openJobsOf, settleObject } from "@memdot/jobs";
import { and, eq, lt, sql } from "drizzle-orm";
import type { Log } from "viem";
import type { Deps } from "../deps.js";

const STORAGE_CURSOR = "transaction_storage";
const REGISTRY_CURSOR = "registry";

interface RecordedArgs {
  owner: `0x${string}`;
  spaceId: `0x${string}`;
  action: number;
  nonce: bigint;
  data: `0x${string}`;
}
/** A fresh database starts one hour (600 blocks) before the head unless told otherwise. */
const BOOTSTRAP_BLOCKS = 600;
/** Blocks one run reads; at ~2 RPCs a block a run stays well under the 1-minute schedule. */
const MAX_BLOCKS_PER_RUN = 120;
const MAX_LOG_RANGE = 1_000;

async function cursorOf(deps: Deps, name: string): Promise<number | null> {
  const [row] = await deps.db.select().from(chainCursors).where(eq(chainCursors.name, name));
  return row?.block ?? null;
}

async function saveCursor(deps: Deps, name: string, block: number): Promise<void> {
  await deps.db
    .insert(chainCursors)
    .values({ name, block })
    .onConflictDoUpdate({ target: chainCursors.name, set: { block, updatedAt: new Date() } });
}

/**
 * Records the relayer's TransactionStorage events in one block and repairs our records from them:
 * a store or renewal that finalized while the worker crashed before writing it down is found here.
 */
export async function indexBlock(deps: Deps, block: number): Promise<number> {
  const events = (await storageEventsAt(deps.chain, block)).filter(
    (event) => event.payer === deps.signer.address,
  );
  if (events.length === 0) return 0;
  const hashes = await extrinsicHashes(deps.chain, block);
  for (const event of events) {
    const txHash = event.extrinsicIndex === null ? null : (hashes[event.extrinsicIndex] ?? null);
    await deps.db.transaction(async (tx) => {
      await tx.execute(sql`
        delete from chain_events
         where source = ${STORAGE_CURSOR} and block = ${block} and name = ${event.kind}
           and payload ->> 'index' = ${String(event.index)}`);
      await tx.insert(chainEvents).values({
        source: STORAGE_CURSOR,
        name: event.kind,
        block,
        txHash,
        payload: {
          index: event.index,
          contentHash: toHex(event.contentHash),
          extrinsicIndex: event.extrinsicIndex,
          feePlanck: event.feePlanck?.toString() ?? null,
        },
      });
    });
    await reconcile(deps, block, event, txHash);
  }
  return events.length;
}

async function reconcile(deps: Deps, block: number, event: StorageEvent, txHash: string | null) {
  const hash = toHex(event.contentHash);
  if (event.kind === "stored") {
    const pending = await deps.db
      .select()
      .from(storedItems)
      .where(and(eq(storedItems.contentHash, hash), eq(storedItems.status, "pending")));
    for (const item of pending) {
      await deps.db.transaction(async (tx) => {
        await tx
          .update(storedItems)
          .set({
            status: "stored",
            block,
            idx: event.index,
            firstBlock: block,
            firstIdx: event.index,
            storedTxHash: txHash,
            storedAt: new Date(),
            feePlanck: event.feePlanck?.toString() ?? null,
            restoreAttempts: 0,
          })
          .where(and(eq(storedItems.id, item.id), eq(storedItems.status, "pending")));
        await tx.delete(blobStaging).where(eq(blobStaging.storedItemId, item.id));
        if (item.objectId) {
          await settleObject(tx, item.objectId, await openJobsOf(tx, item.objectId));
        }
      });
      console.warn(
        `[indexer] recovered an unrecorded store of ${item.cid} at ${block}/${event.index}`,
      );
    }
    return;
  }
  // A renewal we did not record: move the item and keep the history.
  const stale = await deps.db
    .select()
    .from(storedItems)
    .where(
      and(
        eq(storedItems.contentHash, hash),
        eq(storedItems.status, "stored"),
        lt(storedItems.block, block),
      ),
    );
  for (const item of stale) {
    if (!txHash || item.block === null || item.idx === null) continue;
    await deps.db.transaction(async (tx) => {
      await tx
        .insert(renewals)
        .values({
          storedItemId: item.id,
          accountId: item.accountId,
          txHash,
          fromBlock: item.block ?? 0,
          fromIdx: item.idx ?? 0,
          toBlock: block,
          toIdx: event.index,
          feePlanck: event.feePlanck?.toString() ?? null,
        })
        .onConflictDoNothing();
      await tx
        .update(storedItems)
        .set({ block, idx: event.index, lastRenewedAt: new Date(), renewQueuedAt: null })
        .where(and(eq(storedItems.id, item.id), eq(storedItems.block, item.block ?? 0)));
    });
    console.warn(
      `[indexer] recovered an unrecorded renewal of ${item.cid} → ${block}/${event.index}`,
    );
  }
}

/** The scheduled run: follow finalized blocks from the saved cursor. */
export async function indexChain(deps: Deps): Promise<void> {
  const head = (await deps.chain.client.getFinalizedBlock()).number;
  const saved = await cursorOf(deps, STORAGE_CURSOR);
  const from =
    saved === null ? (deps.env.INDEXER_START_BLOCK ?? head - BOOTSTRAP_BLOCKS) : saved + 1;
  const to = Math.min(head, from + MAX_BLOCKS_PER_RUN - 1);
  let found = 0;
  for (let block = from; block <= to; block += 1) found += await indexBlock(deps, block);
  if (to >= from) await saveCursor(deps, STORAGE_CURSOR, to);
  if (found > 0) console.log(`[indexer] blocks ${from}–${to}: ${found} relayer storage events`);
  await indexRegistry(deps);
}

/**
 * MemDotRegistry events (spaces, objects, grants, keys, agents), read with getLogs polling since
 * Revive's RPC has no filters. Raw decoded events land in chain_events for rebuilds and proof pages.
 */
async function indexRegistry(deps: Deps): Promise<void> {
  const address = deps.env.REGISTRY_ADDRESS as `0x${string}`;
  const client = deps.evm.publicClient;
  const head = Number(await client.getBlockNumber());
  const saved = await cursorOf(deps, REGISTRY_CURSOR);
  const from =
    saved === null ? (deps.env.INDEXER_START_BLOCK ?? head - BOOTSTRAP_BLOCKS) : saved + 1;
  const to = Math.min(head, from + MAX_LOG_RANGE - 1);
  if (to < from) return;
  const logs = await client.getContractEvents({
    address,
    abi: memDotRegistryAbi,
    fromBlock: BigInt(from),
    toBlock: BigInt(to),
  });
  for (const log of logs as (Log & { eventName: string; args: RecordedArgs })[]) {
    const { owner, spaceId, action, nonce, data } = log.args;
    // Readers apply an (owner, nonce) pair once: a replayed signed record changes nothing.
    const [seen] = await deps.db
      .select({ id: chainEvents.id })
      .from(chainEvents)
      .where(
        and(
          eq(chainEvents.source, REGISTRY_CURSOR),
          sql`${chainEvents.payload}->>'owner' = ${owner}`,
          sql`${chainEvents.payload}->>'nonce' = ${nonce.toString()}`,
        ),
      )
      .limit(1);
    if (seen) continue;
    await deps.db.insert(chainEvents).values({
      source: REGISTRY_CURSOR,
      name: actionName(action) ?? `Action${action}`,
      block: Number(log.blockNumber),
      txHash: log.transactionHash,
      payload: JSON.parse(
        JSON.stringify(
          { owner, spaceId, action, nonce, record: decodeRecord(action, data) },
          (_k, v) => (typeof v === "bigint" ? v.toString() : v),
        ),
      ),
    });
  }
  await saveCursor(deps, REGISTRY_CURSOR, to);
  if (logs.length > 0) console.log(`[indexer] registry ${from}–${to}: ${logs.length} events`);
}
