import {
  type Database,
  memories,
  memoryHistory,
  memoryTerms,
  objects,
  storedItems,
} from "@memdot/db";
import {
  dedupeKey,
  type MemoryChange,
  type MemoryEntry,
  normalizeEntity,
  termFrequencies,
} from "@memdot/memory-engine";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { AssistedKeys } from "./keys.js";

export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type MemoryRow = typeof memories.$inferSelect;
type ObjectRow = typeof objects.$inferSelect;
type Executor = Pick<Database, "select" | "insert" | "update" | "delete" | "execute">;

const CHUNK = 500;

/** Replaces a memory's keyword index with blinded terms for this text. */
export async function writeTerms(
  tx: Executor,
  keys: AssistedKeys,
  memoryId: string,
  folderId: string,
  text: string,
): Promise<number> {
  await tx.delete(memoryTerms).where(eq(memoryTerms.memoryId, memoryId));
  const blinded = new Map<string, number>();
  let total = 0;
  for (const [term, count] of termFrequencies(text)) {
    total += count;
    const hash = keys.blindTerm(folderId, term);
    blinded.set(hash, (blinded.get(hash) ?? 0) + count);
  }
  const rows = [...blinded].map(([term, count]) => ({ memoryId, folderId, term, count }));
  for (let start = 0; start < rows.length; start += CHUNK) {
    await tx.insert(memoryTerms).values(rows.slice(start, start + CHUNK));
  }
  return total;
}

export const blindEntities = (
  keys: AssistedKeys,
  folderId: string,
  names: string[] | null | undefined,
): string[] => [
  ...new Set(
    (names ?? []).map((name) => keys.blindTerm(folderId, `entity:${normalizeEntity(name)}`)),
  ),
];

export function blindDedupeKey(
  keys: AssistedKeys,
  folderId: string,
  text: string,
  scope: { userId?: string | null; agentId?: string | null; runId?: string | null },
): string {
  return keys.blindTerm(folderId, `dedupe:${dedupeKey(text, scope)}`);
}

/** What only the holder of the namespace's key can read: the text and the names it mentions. */
export interface MemoryBody {
  text: string;
  entities?: string[] | undefined;
}

export const sealBody = (keys: AssistedKeys, folderId: string, body: MemoryBody): Uint8Array =>
  keys.sealRowText(folderId, JSON.stringify(body));

export const openBody = (keys: AssistedKeys, folderId: string, sealed: Uint8Array): MemoryBody =>
  JSON.parse(keys.openRowText(folderId, sealed)) as MemoryBody;

/** What a memory's segment entry holds: everything needed to rebuild it from the chain. */
export function entryOf(
  row: MemoryRow,
  text: string,
  history: MemoryChange[],
  entities: string[] | undefined,
): MemoryEntry {
  const source =
    row.sourceKind === null
      ? undefined
      : ({
          kind: row.sourceKind,
          ...(row.sourceObjectId ? { objectId: row.sourceObjectId } : {}),
          ...(row.sourceLabel ? { label: row.sourceLabel } : {}),
        } as MemoryEntry["source"]);
  return {
    v: 1,
    id: row.id,
    version: row.version,
    text,
    ...(row.userId ? { userId: row.userId } : {}),
    ...(row.agentId ? { agentId: row.agentId } : {}),
    ...(row.runId ? { runId: row.runId } : {}),
    ...(row.metadata ? { metadata: row.metadata as Record<string, unknown> } : {}),
    ...(row.categories?.length ? { categories: row.categories } : {}),
    ...(entities?.length ? { entities } : {}),
    ...(row.memoryType ? { memoryType: row.memoryType as "fact" | "procedural" } : {}),
    ...(row.attributedTo ? { attributedTo: row.attributedTo as "user" | "assistant" } : {}),
    ...(source ? { source } : {}),
    ...(row.raw ? { raw: true } : {}),
    ...(row.immutable ? { immutable: true } : {}),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(row.occurredAt ? { occurredAt: row.occurredAt.toISOString() } : {}),
    ...(row.expiresAt ? { expiresAt: row.expiresAt.toISOString() } : {}),
    ...(history.length ? { history } : {}),
  };
}

/** A memory's events, oldest first, with the text opened. */
export async function historyOf(
  tx: Pick<Database, "select">,
  keys: AssistedKeys,
  folderId: string,
  memoryIds: string[],
): Promise<Map<string, MemoryChange[]>> {
  const rows = memoryIds.length
    ? await tx
        .select()
        .from(memoryHistory)
        .where(inArray(memoryHistory.memoryId, memoryIds))
        .orderBy(asc(memoryHistory.id))
    : [];
  const byMemory = new Map<string, MemoryChange[]>();
  for (const row of rows) {
    const list = byMemory.get(row.memoryId) ?? [];
    list.push({
      event: row.event,
      text: row.sealedText ? keys.openRowText(folderId, row.sealedText) : null,
      previous: row.sealedPrevious ? keys.openRowText(folderId, row.sealedPrevious) : null,
      at: row.createdAt.toISOString(),
      ...(row.actor ? { actor: row.actor } : {}),
    });
    byMemory.set(row.memoryId, list);
  }
  return byMemory;
}

/**
 * Forgets memories (R6): drops them from every index, wipes their text and the text in their
 * history, and keeps only the fact that they existed and were deleted. Returns the segments that
 * might now hold nothing live.
 */
export async function forgetRows(
  tx: Executor,
  where: ReturnType<typeof and>,
  actor: string | null,
): Promise<{ ids: string[]; segmentIds: string[] }> {
  const gone = await tx
    .update(memories)
    .set({
      deletedAt: new Date(),
      sealedText: null,
      embedding: null,
      entityTerms: null,
      metadata: null,
      dedupeKey: null,
      termCount: 0,
    })
    .where(and(where, sql`${memories.deletedAt} is null`))
    .returning({ id: memories.id, segmentId: memories.segmentId, version: memories.version });
  const ids = gone.map((row) => row.id);
  for (let start = 0; start < ids.length; start += CHUNK) {
    const batch = ids.slice(start, start + CHUNK);
    await tx.delete(memoryTerms).where(inArray(memoryTerms.memoryId, batch));
    await tx
      .update(memoryHistory)
      .set({ sealedText: null, sealedPrevious: null })
      .where(inArray(memoryHistory.memoryId, batch));
  }
  if (gone.length > 0) {
    await tx.insert(memoryHistory).values(
      gone.map((row) => ({
        memoryId: row.id,
        event: "DELETE" as const,
        version: row.version,
        actor,
      })),
    );
  }
  return {
    ids,
    segmentIds: [...new Set(gone.flatMap((row) => (row.segmentId ? [row.segmentId] : [])))],
  };
}

/** Where a memory's bytes are: its segment's CID and whether the chain has them. */
export async function segmentStates(
  tx: Pick<Database, "select">,
  segmentIds: string[],
): Promise<Map<string, { cid: string; status: ObjectRow["status"]; block: number | null }>> {
  if (segmentIds.length === 0) return new Map();
  const rows = await tx
    .select({
      id: objects.id,
      cid: objects.cid,
      status: objects.status,
      block: storedItems.block,
    })
    .from(objects)
    .leftJoin(storedItems, and(eq(storedItems.objectId, objects.id), eq(storedItems.role, "root")))
    .where(inArray(objects.id, [...new Set(segmentIds)]));
  return new Map(
    rows.map((row) => [row.id, { cid: row.cid ?? "", status: row.status, block: row.block }]),
  );
}
