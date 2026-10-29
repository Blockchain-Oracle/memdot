import { type Database, grants, spaces } from "@memdot/db";
import { and, inArray, type SQL, sql } from "drizzle-orm";

type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/**
 * One way to revoke (R5): mark the grants revoked and move each affected space to a new key
 * epoch, so the owner's client rotates the space key and future writes are unreadable to the
 * former grantee. Anything they already opened may have been kept.
 */
export async function revokeGrants(tx: Tx, where: SQL): Promise<number> {
  const revoked = await tx
    .update(grants)
    .set({ status: "revoked", revokedAt: new Date() })
    .where(and(where, inArray(grants.status, ["pending", "active"])))
    .returning({ spaceId: grants.spaceId });
  const spaceIds = [...new Set(revoked.map((g) => g.spaceId))];
  if (spaceIds.length > 0) {
    await tx
      .update(spaces)
      .set({ keyEpoch: sql`${spaces.keyEpoch} + 1` })
      .where(inArray(spaces.id, spaceIds));
  }
  return revoked.length;
}
