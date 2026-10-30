import { type Database, grants, objects, spaces } from "@memdot/db";
import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import { tombstoneObjects } from "./lifecycle.js";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * One way to revoke (R5): mark the grants revoked, move each affected space to a new key epoch
 * (so the owner's client seals future writes with a key the former grantee never had) and stop
 * renewing the grants' wrapped keys. Anything they already opened may have been kept.
 */
export async function revokeGrants(tx: Tx, where: SQL): Promise<number> {
  const revoked = await tx
    .update(grants)
    .set({ status: "revoked", revokedAt: new Date() })
    .where(and(where, inArray(grants.status, ["pending", "active"])))
    .returning({ spaceId: grants.spaceId, wrappedKeyCid: grants.wrappedKeyCid });
  const spaceIds = [...new Set(revoked.map((g) => g.spaceId))];
  if (spaceIds.length > 0) {
    await tx
      .update(spaces)
      .set({ keyEpoch: sql`${spaces.keyEpoch} + 1` })
      .where(inArray(spaces.id, spaceIds));
  }
  const keyCids = revoked.flatMap((g) => (g.wrappedKeyCid ? [g.wrappedKeyCid] : []));
  if (keyCids.length > 0) {
    // Wrapped keys are the space owner's account objects.
    await tombstoneObjects(
      tx,
      and(
        eq(objects.kind, "grant_key"),
        inArray(objects.cid, keyCids),
        inArray(
          objects.accountId,
          tx.select({ id: spaces.accountId }).from(spaces).where(inArray(spaces.id, spaceIds)),
        ),
      ) as SQL,
    );
  }
  return revoked.length;
}
