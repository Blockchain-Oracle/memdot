import { type Database, objects, spaces, storedItems } from "@memdot/db";
import { and, eq, inArray, isNull, ne, type SQL, sql } from "drizzle-orm";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * One delete semantics (R6): tombstone the objects, stop renewing their blobs, drop staged
 * ciphertext and give the bytes back to each space's quota. Bytes already on chain expire on
 * their own within the retention window.
 */
export async function tombstoneObjects(tx: Tx, where: SQL): Promise<number> {
  const tombstoned = await tx
    .update(objects)
    .set({ status: "tombstoned", tombstonedAt: new Date() })
    .where(and(where, ne(objects.status, "tombstoned")))
    .returning({ id: objects.id, spaceId: objects.spaceId });
  if (tombstoned.length === 0) return 0;
  const ids = tombstoned.map((o) => o.id);

  const released = await tx
    .update(storedItems)
    .set({ status: "released" })
    .where(and(inArray(storedItems.objectId, ids), ne(storedItems.status, "released")))
    .returning({ objectId: storedItems.objectId, sizeBytes: storedItems.sizeBytes });

  const freed = new Map<string, number>();
  const spaceOf = new Map(tombstoned.map((o) => [o.id, o.spaceId]));
  for (const item of released) {
    const spaceId = item.objectId ? spaceOf.get(item.objectId) : null;
    if (spaceId) freed.set(spaceId, (freed.get(spaceId) ?? 0) + item.sizeBytes);
  }
  for (const [spaceId, bytes] of freed) {
    await tx
      .update(spaces)
      .set({ usedBytes: sql`greatest(${spaces.usedBytes} - ${bytes}, 0)` })
      .where(and(eq(spaces.id, spaceId), isNull(spaces.deletedAt)));
  }
  // Ciphertext still waiting to be stored is no longer wanted. The stored item rows stay as the
  // record, so the staging table's cascade never fires; delete it here.
  await tx.execute(
    sql`delete from blob_staging using stored_items where blob_staging.stored_item_id = stored_items.id and ${inArray(storedItems.objectId, ids)}`,
  );
  return tombstoned.length;
}
