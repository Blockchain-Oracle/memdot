import { memories, memoryHistory } from "@memdot/db";
import {
  type ChatMessage,
  type ImportItem,
  type MemoryRelation,
  type MemorySource,
  type PromptCategory,
  SERVER_EMBEDDING_DIMENSIONS,
} from "@memdot/memory-engine";
import { sql } from "drizzle-orm";
import type { AssistedKeys } from "./keys.js";
import { blindDedupeKey, blindEntities, sealBody, type Tx, writeTerms } from "./rows.js";

/** A write as it waits in the queue, sealed: plaintext is never at rest on the server (R10). */
export interface AddWrite {
  kind: "add";
  messages: ChatMessage[];
  userId?: string | undefined;
  agentId?: string | undefined;
  runId?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  expiresAt?: string | undefined;
  occurredAt?: string | undefined;
  infer: boolean;
  procedural: boolean;
  prompt?: string | undefined;
  categories?: PromptCategory[] | undefined;
  immutable?: boolean | undefined;
  source?: MemorySource | undefined;
  actor?: string | undefined;
}

export interface ImportWrite {
  kind: "import";
  items: ImportItem[];
  source: string;
  actor?: string | undefined;
}

export type MemoryWrite = AddWrite | ImportWrite;

export const sealWrite = (keys: AssistedKeys, folderId: string, write: MemoryWrite): Uint8Array =>
  keys.sealRowText(folderId, JSON.stringify(write));

export const openWrite = (keys: AssistedKeys, folderId: string, sealed: Uint8Array): MemoryWrite =>
  JSON.parse(keys.openRowText(folderId, sealed)) as MemoryWrite;

/** One memory about to be indexed. */
export interface MemoryDraft {
  id?: string | undefined;
  text: string;
  entities?: string[] | undefined;
  relations?: MemoryRelation[] | undefined;
  categories?: string[] | undefined;
  attributedTo?: "user" | "assistant" | undefined;
  memoryType?: "fact" | "procedural" | undefined;
  raw?: boolean | undefined;
  immutable?: boolean | undefined;
  userId?: string | undefined;
  agentId?: string | undefined;
  runId?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  source?: MemorySource | undefined;
  occurredAt?: Date | undefined;
  expiresAt?: Date | undefined;
  createdAt?: Date | undefined;
  updatedAt?: Date | undefined;
  version?: number | undefined;
  embedding?: number[] | null | undefined;
  embeddingModel?: string | undefined;
}

export interface NamespaceScope {
  accountId: string;
  spaceId: string;
  folderId: string;
}

/**
 * Indexes new memories and records their ADD events. The same fact in the same scope is dropped
 * by a unique index, so concurrent writes and retried jobs can't store it twice.
 */
export async function insertDrafts(
  tx: Tx,
  keys: AssistedKeys,
  scope: NamespaceScope,
  drafts: MemoryDraft[],
  actor: string | null,
): Promise<{ inserted: string[]; duplicates: number }> {
  const inserted: string[] = [];
  let duplicates = 0;
  for (const draft of drafts) {
    const usableVector =
      draft.embedding?.length === SERVER_EMBEDDING_DIMENSIONS ? draft.embedding : null;
    const [row] = await tx
      .insert(memories)
      .values({
        ...(draft.id ? { id: draft.id } : {}),
        accountId: scope.accountId,
        spaceId: scope.spaceId,
        folderId: scope.folderId,
        mode: "assisted",
        version: draft.version ?? 1,
        sourceObjectId: draft.source?.objectId ?? null,
        sourceKind: draft.source?.kind ?? null,
        sourceLabel: draft.source?.label ?? null,
        userId: draft.userId ?? null,
        agentId: draft.agentId ?? null,
        runId: draft.runId ?? null,
        metadata: draft.metadata ?? null,
        categories: draft.categories ?? null,
        entityTerms: blindEntities(keys, scope.folderId, draft.entities),
        memoryType: draft.memoryType ?? "fact",
        attributedTo: draft.attributedTo ?? null,
        raw: draft.raw ?? false,
        immutable: draft.immutable ?? false,
        sealedText: sealBody(keys, scope.folderId, {
          text: draft.text,
          entities: draft.entities,
          relations: draft.relations,
        }),
        dedupeKey: blindDedupeKey(keys, scope.folderId, draft.text, draft),
        embedding: usableVector,
        embeddingModel: usableVector ? (draft.embeddingModel ?? null) : null,
        occurredAt: draft.occurredAt ?? null,
        expiresAt: draft.expiresAt ?? null,
        ...(draft.createdAt ? { createdAt: draft.createdAt } : {}),
        ...(draft.updatedAt ? { updatedAt: draft.updatedAt } : {}),
      })
      .onConflictDoNothing({
        target: [memories.folderId, memories.dedupeKey],
        where: sql`${memories.dedupeKey} is not null and ${memories.deletedAt} is null`,
      })
      .returning({ id: memories.id });
    if (!row) {
      duplicates += 1;
      continue;
    }
    const termCount = await writeTerms(tx, keys, row.id, scope.folderId, draft.text);
    await tx.update(memories).set({ termCount }).where(sql`${memories.id} = ${row.id}`);
    await tx.insert(memoryHistory).values({
      memoryId: row.id,
      event: "ADD",
      version: draft.version ?? 1,
      sealedText: keys.sealRowText(scope.folderId, draft.text),
      actor,
    });
    inserted.push(row.id);
  }
  return { inserted, duplicates };
}
