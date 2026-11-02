import { cidOf, contentHash, toHex } from "@memdot/chain";
import { CHUNK_BYTES, SEGMENT_PACK_BYTES } from "@memdot/config";
import { packSegment } from "@memdot/crypto";
import {
  accounts,
  blobStaging,
  jobs,
  memories,
  memorySegments,
  objects,
  spaces,
  storedItems,
} from "@memdot/db";
import { enqueueChainTx, updateJob } from "@memdot/jobs";
import { encodeEntry } from "@memdot/memory-engine";
import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { AssistedKeys } from "./keys.js";
import { entryOf, historyOf, openBody, type Tx } from "./rows.js";

export class MemoryQuotaError extends Error {
  constructor() {
    super("This space's sponsored storage is full. Delete something or move it to your wallet.");
    this.name = "MemoryQuotaError";
  }
}

/**
 * Writes these memories' current state as new encrypted segments on V3, through the relayer's
 * serial queue, and points the rows at them. Sealed to the namespace's server key and to the owner.
 * `jobId` follows the first segment; any further ones (a big import) follow it through their rows.
 */
export async function persistMemories(
  tx: Tx,
  boss: PgBoss,
  keys: AssistedKeys,
  input: { folderId: string; memoryIds: string[]; jobId: string },
): Promise<{ segmentIds: string[] }> {
  if (input.memoryIds.length === 0) return { segmentIds: [] };
  const rows = await tx
    .select()
    .from(memories)
    .where(and(inArray(memories.id, input.memoryIds), isNull(memories.deletedAt)));
  const first = rows[0];
  if (!first) return { segmentIds: [] };
  const [owner] = await tx
    .select({ encryptionKey: accounts.encryptionKey })
    .from(accounts)
    .where(eq(accounts.id, first.accountId));
  if (!owner?.encryptionKey) throw new Error(`account ${first.accountId} has no sharing key`);

  const history = await historyOf(tx, keys, input.folderId, input.memoryIds);
  const encoded = rows.map((row) => {
    if (!row.sealedText) throw new Error(`memory ${row.id} has no text to persist`);
    const body = openBody(keys, input.folderId, row.sealedText);
    const entry = entryOf(row, body.text, history.get(row.id) ?? [], body.entities);
    return { id: row.id, data: encodeEntry(entry) };
  });

  // One segment per job unless the job is too big for one stored blob.
  const groups: (typeof encoded)[] = [];
  let bytes = 0;
  for (const item of encoded) {
    const last = groups.at(-1);
    if (!last || bytes + item.data.length > SEGMENT_PACK_BYTES) {
      groups.push([item]);
      bytes = item.data.length;
    } else {
      last.push(item);
      bytes += item.data.length;
    }
  }

  const segmentIds: string[] = [];
  for (const [position, group] of groups.entries()) {
    const packed = packSegment(group.map((item) => ({ ...item, kind: "memory" as const })));
    const sealed = await keys.sealSegment(input.folderId, owner.encryptionKey, packed);
    if (sealed.length > CHUNK_BYTES) throw new Error("a memory segment exceeds one storage chunk");

    const reserved = await tx
      .update(spaces)
      .set({ usedBytes: sql`${spaces.usedBytes} + ${sealed.length}` })
      .where(
        and(
          eq(spaces.id, first.spaceId),
          sql`${spaces.usedBytes} + ${sealed.length} <= ${spaces.quotaBytes}`,
        ),
      )
      .returning({ id: spaces.id });
    if (reserved.length === 0) throw new MemoryQuotaError();

    const [space] = await tx
      .select({ keyEpoch: spaces.keyEpoch })
      .from(spaces)
      .where(eq(spaces.id, first.spaceId));
    const cid = cidOf(sealed);
    const hash = toHex(contentHash(sealed));
    const [object] = await tx
      .insert(objects)
      .values({
        accountId: first.accountId,
        spaceId: first.spaceId,
        folderId: input.folderId,
        kind: "segment",
        status: "uploading",
        contentHash: hash,
        cid,
        sizeBytes: sealed.length,
        relayed: true,
        reservedBytes: sealed.length,
        keyEpoch: space?.keyEpoch ?? 0,
      })
      .returning({ id: objects.id });
    if (!object) throw new Error("segment insert returned no row");
    const [item] = await tx
      .insert(storedItems)
      .values({
        objectId: object.id,
        accountId: first.accountId,
        role: "root",
        chunkIndex: 0,
        contentHash: hash,
        cid,
        sizeBytes: sealed.length,
      })
      .returning({ id: storedItems.id });
    if (!item) throw new Error("stored item insert returned no row");
    await tx.insert(blobStaging).values({ storedItemId: item.id, data: sealed });
    await tx
      .insert(memorySegments)
      .values({ objectId: object.id, folderId: input.folderId, entries: group.length });
    await tx
      .update(memories)
      .set({ segmentId: object.id })
      .where(
        inArray(
          memories.id,
          group.map((entry) => entry.id),
        ),
      );

    // The job follows the first segment to finality; `settleObject` closes it.
    if (position === 0) {
      await tx.update(jobs).set({ objectId: object.id }).where(eq(jobs.id, input.jobId));
      await updateJob(tx, input.jobId, { progress: { done: 0, total: 1 } });
    }
    await enqueueChainTx(boss, tx, { action: "store", jobId: input.jobId, storedItemId: item.id });
    segmentIds.push(object.id);
  }
  return { segmentIds };
}

/** Segments that have no live memory left, so nothing needs them renewed. */
export async function emptySegments(
  tx: Pick<Tx, "select" | "selectDistinct">,
  segmentIds: string[],
): Promise<string[]> {
  if (segmentIds.length === 0) return [];
  const live = await tx
    .selectDistinct({ id: memories.segmentId })
    .from(memories)
    .where(and(inArray(memories.segmentId, segmentIds), isNull(memories.deletedAt)));
  const held = new Set(live.map((row) => row.id));
  const candidates = segmentIds.filter((id) => !held.has(id));
  if (candidates.length === 0) return [];
  // A file segment or an already deleted one is not ours to touch.
  const known = await tx
    .select({ id: memorySegments.objectId })
    .from(memorySegments)
    .innerJoin(objects, eq(objects.id, memorySegments.objectId))
    .where(
      and(
        inArray(memorySegments.objectId, candidates),
        notInArray(objects.status, ["tombstoned", "failed"]),
      ),
    );
  return known.map((row) => row.id);
}

/** How many entries each live segment in a namespace still holds, against how many it was written with. */
export async function segmentHealth(
  tx: Pick<Tx, "execute">,
  folderId: string,
): Promise<{ id: string; entries: number; live: number; bytes: number }[]> {
  const result = await tx.execute<{ id: string; entries: number; live: number; bytes: string }>(sql`
    select s.object_id as id, s.entries,
           count(m.id) filter (where m.deleted_at is null)::int as live,
           o.size_bytes as bytes
      from memory_segments s
      join objects o on o.id = s.object_id
      left join memories m on m.segment_id = s.object_id
     where s.folder_id = ${folderId}
       and o.status not in ('tombstoned', 'failed')
     group by s.object_id, s.entries, o.size_bytes`);
  return result.rows.map((row) => ({ ...row, bytes: Number(row.bytes) }));
}
