import { bitswapGet } from "@memdot/chain";
import { unpackSegment } from "@memdot/crypto";
import {
  blobStaging,
  folders,
  jobs,
  memories,
  memoryHistory,
  memoryInbox,
  memorySegments,
  memorySettings,
  objects,
  spaces,
  storedItems,
} from "@memdot/db";
import type { MemoryPayload } from "@memdot/jobs";
import { updateJob } from "@memdot/jobs";
import {
  decodeEntry,
  type Embedder,
  hasAttachments,
  type MemoryEntry,
  messageText,
  type PromptCategory,
  parseFilter,
  tokenize,
} from "@memdot/memory-engine";
import { extractMemories, type FetchDocument, proceduralRecord } from "@memdot/memory-engine/llm";
import {
  type AccountModels,
  type AddWrite,
  blindDedupeKey,
  blindEntities,
  COMPACT_ABOVE_SEGMENTS,
  compactIfDue,
  type ImportWrite,
  insertDrafts,
  type MemoryDraft,
  MemoryQuotaError,
  modelsFor,
  type NamespaceScope,
  openBody,
  openWrite,
  persistMemories,
  safeFetch,
  sealBody,
  searchMemories,
  segmentHealth,
  tombstoneObjects,
  writeTerms,
} from "@memdot/memory-server";
import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import type { JobWithMetadata } from "pg-boss";
import { type Deps, errorText } from "../deps.js";

/** Largest document a memory may name by URL. */
const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;
const DOCUMENT_TIMEOUT_MS = 20_000;
/** Nearby memories shown to the model, so it doesn't write the same fact again. */
const KNOWN_MEMORIES = 10;
/** Characters of a conversation used to find them. */
const KNOWN_QUERY_CHARS = 2_000;
/** Texts sent to an embedding model in one call. */
const EMBED_BATCH = 96;

/**
 * Reads at most MAX_DOCUMENT_BYTES, stopping as soon as a document goes past it, and refuses private
 * addresses. Errors don't name the URL: they end up on the job, and a URL can carry secrets.
 */
const fetchDocument: FetchDocument = async (url) => {
  const response = await safeFetch(url, { signal: AbortSignal.timeout(DOCUMENT_TIMEOUT_MS) });
  if (!response.ok)
    throw new Error(`Couldn't fetch a document: the host answered ${response.status}.`);
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (reader) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_DOCUMENT_BYTES) {
      await reader.cancel();
      throw new Error("A document is too large to read.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return { bytes, mime: response.headers.get("content-type")?.split(";")[0] ?? "" };
};

async function loadScope(
  deps: Deps,
  folderId: string,
): Promise<NamespaceScope & { spaceId: string }> {
  const [row] = await deps.db
    .select({ spaceId: folders.spaceId, accountId: spaces.accountId })
    .from(folders)
    .innerJoin(spaces, eq(spaces.id, folders.spaceId))
    .where(eq(folders.id, folderId));
  if (!row) throw new Error(`namespace ${folderId} is gone`);
  return { accountId: row.accountId, spaceId: row.spaceId, folderId };
}

async function embedAll(embedder: Embedder | null, texts: string[]) {
  if (!embedder) return texts.map(() => null);
  const vectors: (number[] | null)[] = [];
  for (let start = 0; start < texts.length; start += EMBED_BATCH) {
    vectors.push(...(await embedder.embed(texts.slice(start, start + EMBED_BATCH), "document")));
  }
  return vectors;
}

/** What's already stored near this conversation. A failed lookup only risks a duplicate. */
async function knownNearby(
  deps: Deps,
  folderId: string,
  write: AddWrite,
  embedder: Embedder | null,
): Promise<string[]> {
  if (!embedder) return [];
  const query = write.messages.map(messageText).join("\n").slice(0, KNOWN_QUERY_CHARS);
  if (!query.trim()) return [];
  const scope = {
    ...(write.userId ? { user_id: write.userId } : {}),
    ...(write.agentId ? { agent_id: write.agentId } : {}),
    ...(write.runId ? { run_id: write.runId } : {}),
  };
  try {
    const hits = await searchMemories(deps.db, deps.memoryKeys, {
      folderId,
      query,
      limit: KNOWN_MEMORIES,
      threshold: 0,
      mode: "semantic",
      filter: Object.keys(scope).length ? parseFilter(scope) : undefined,
      at: new Date(),
      showExpired: true,
      embedder,
    });
    if (hits.length === 0) return [];
    const rows = await deps.db
      .select({ sealedText: memories.sealedText })
      .from(memories)
      .where(
        inArray(
          memories.id,
          hits.map((hit) => hit.id),
        ),
      );
    return rows.flatMap((row) =>
      row.sealedText ? [openBody(deps.memoryKeys, folderId, row.sealedText).text] : [],
    );
  } catch (error) {
    console.warn("[memory] nearby lookup skipped:", errorText(error));
    return [];
  }
}

async function namespaceSettings(deps: Deps, folderId: string) {
  const [row] = await deps.db
    .select({
      customInstructions: memorySettings.customInstructions,
      categories: memorySettings.categories,
    })
    .from(memorySettings)
    .where(eq(memorySettings.folderId, folderId));
  return {
    instructions: row?.customInstructions ?? null,
    categories: (row?.categories as PromptCategory[] | null) ?? null,
  };
}

/** The text of every user or assistant turn, one memory each: what `infer: false` stores. */
function asWritten(write: AddWrite): MemoryDraft[] {
  return write.messages.flatMap((message) => {
    const text = messageText(message).trim();
    if (!text || message.role === "system") return [];
    return [
      {
        text,
        attributedTo: message.role === "assistant" ? ("assistant" as const) : ("user" as const),
      },
    ];
  });
}

/** The conversation as one memory, because the model couldn't read it. Better kept than lost. */
function rawFallback(write: AddWrite): MemoryDraft[] {
  const text = write.messages
    .filter((message) => message.role !== "system")
    .map(messageText)
    .join("\n")
    .trim();
  return text ? [{ text, raw: true }] : [];
}

async function draftsFor(
  deps: Deps,
  folderId: string,
  write: AddWrite,
  models: AccountModels,
  finalAttempt: boolean,
): Promise<MemoryDraft[]> {
  if (!write.infer) return asWritten(write);
  if (!models.llm) return rawFallback(write);
  const observedAt = write.occurredAt ? new Date(write.occurredAt) : new Date();
  try {
    if (write.procedural) {
      const text = await proceduralRecord(models.llm, write.messages, fetchDocument, write.prompt);
      return [{ text, memoryType: "procedural" }];
    }
    const settings = await namespaceSettings(deps, folderId);
    const extracted = await extractMemories(models.llm, {
      messages: write.messages,
      known: hasAttachments(write.messages)
        ? []
        : await knownNearby(deps, folderId, write, models.embedder),
      instructions: write.prompt ?? settings.instructions,
      categories: write.categories ?? settings.categories,
      observedAt,
      agentScoped: Boolean(write.agentId && !write.userId),
      fetchDocument,
    });
    return extracted.map((memory) => ({
      text: memory.text,
      entities: memory.entities,
      categories: memory.categories,
      attributedTo: memory.attributed_to,
    }));
  } catch (error) {
    // Rate limits are usually gone by the next try; only the last one settles for raw text.
    if (!finalAttempt) throw error;
    console.warn("[memory] extraction failed, keeping the raw text:", errorText(error));
    return rawFallback(write);
  }
}

async function handleAdd(deps: Deps, job: typeof jobs.$inferSelect, finalAttempt: boolean) {
  const folderId = (job.payload as { folderId: string }).folderId;
  const [inbox] = await deps.db.select().from(memoryInbox).where(eq(memoryInbox.jobId, job.id));
  if (!inbox) return; // Finished by an earlier attempt.
  const write = openWrite(deps.memoryKeys, folderId, inbox.sealed) as AddWrite;
  const scope = await loadScope(deps, folderId);
  await updateJob(deps.db, job.id, { status: "running" });
  const models = await modelsFor(deps.db, deps.memoryKeys, deps.env, scope.accountId);

  const drafts = await draftsFor(deps, folderId, write, models, finalAttempt);
  const vectors = await embedAll(
    models.embedder,
    drafts.map((draft) => draft.text),
  ).catch((error) => {
    // Without a vector a memory can still be found by its words; Restore fills vectors in later.
    console.warn("[memory] embedding failed:", errorText(error));
    return drafts.map(() => null);
  });
  const prepared: MemoryDraft[] = drafts.map((draft, i) => ({
    ...draft,
    userId: write.userId,
    agentId: write.agentId,
    runId: write.runId,
    metadata: write.metadata,
    source: write.source,
    immutable: write.immutable,
    occurredAt: write.occurredAt ? new Date(write.occurredAt) : undefined,
    expiresAt: write.expiresAt ? new Date(write.expiresAt) : undefined,
    embedding: vectors[i],
    embeddingModel: models.embedder?.modelId,
  }));

  await deps.db.transaction(async (tx) => {
    const { inserted, duplicates } = await insertDrafts(
      tx,
      deps.memoryKeys,
      scope,
      prepared,
      write.actor ?? null,
    );
    await persistMemories(tx, deps.boss, deps.memoryKeys, {
      folderId,
      memoryIds: inserted,
      jobId: job.id,
    });
    await tx.delete(memoryInbox).where(eq(memoryInbox.jobId, job.id));
    await updateJob(tx, job.id, {
      result: {
        indexed: true,
        memories: inserted.map((id) => ({ id, event: "ADD" })),
        duplicates,
        ...(!models.llm && write.infer
          ? { note: "No model is set, so this was stored as written." }
          : {}),
      },
      // Nothing new means nothing to store, so the job has nothing left to wait for.
      ...(inserted.length === 0 ? { status: "finalized" as const } : {}),
    });
  });
  await compactIfDue(deps.db, deps.boss, scope);
}

async function handleImport(deps: Deps, job: typeof jobs.$inferSelect) {
  const folderId = (job.payload as { folderId: string }).folderId;
  const [inbox] = await deps.db.select().from(memoryInbox).where(eq(memoryInbox.jobId, job.id));
  if (!inbox) return;
  const write = openWrite(deps.memoryKeys, folderId, inbox.sealed) as ImportWrite;
  const scope = await loadScope(deps, folderId);
  await updateJob(deps.db, job.id, { status: "running" });
  const models = await modelsFor(deps.db, deps.memoryKeys, deps.env, scope.accountId);
  const vectors = await embedAll(
    models.embedder,
    write.items.map((item) => item.text),
  ).catch((error) => {
    console.warn("[memory] import embedding failed:", errorText(error));
    return write.items.map(() => null);
  });
  const drafts: MemoryDraft[] = write.items.map((item, i) => ({
    text: item.text,
    userId: item.userId,
    agentId: item.agentId,
    runId: item.runId,
    metadata: item.metadata,
    categories: item.categories,
    source: { kind: "import", label: write.source },
    createdAt: item.createdAt ? new Date(item.createdAt) : undefined,
    updatedAt: item.updatedAt ? new Date(item.updatedAt) : undefined,
    expiresAt: item.expiresAt ? new Date(item.expiresAt) : undefined,
    embedding: vectors[i],
    embeddingModel: models.embedder?.modelId,
  }));
  await deps.db.transaction(async (tx) => {
    const { inserted, duplicates } = await insertDrafts(
      tx,
      deps.memoryKeys,
      scope,
      drafts,
      write.actor ?? null,
    );
    await persistMemories(tx, deps.boss, deps.memoryKeys, {
      folderId,
      memoryIds: inserted,
      jobId: job.id,
    });
    await tx.delete(memoryInbox).where(eq(memoryInbox.jobId, job.id));
    await updateJob(tx, job.id, {
      result: {
        indexed: true,
        memories: inserted.map((id) => ({ id, event: "ADD" })),
        duplicates,
      },
      ...(inserted.length === 0 ? { status: "finalized" as const } : {}),
    });
  });
}

/** The newest version of every memory in a namespace's segments, read back from the chain. */
async function readChainEntries(deps: Deps, folderId: string) {
  const segments = await deps.db
    .select({
      id: objects.id,
      cid: objects.cid,
      staged: blobStaging.data,
    })
    .from(memorySegments)
    .innerJoin(objects, eq(objects.id, memorySegments.objectId))
    .innerJoin(storedItems, and(eq(storedItems.objectId, objects.id), eq(storedItems.role, "root")))
    .leftJoin(blobStaging, eq(blobStaging.storedItemId, storedItems.id))
    .where(
      and(
        eq(memorySegments.folderId, folderId),
        notInArray(objects.status, ["tombstoned", "failed"]),
      ),
    );
  const newest = new Map<string, MemoryEntry>();
  for (const segment of segments) {
    if (!segment.cid) continue;
    const sealed = segment.staged ?? (await bitswapGet(deps.chain.client, segment.cid));
    const opened = await deps.memoryKeys.openSegment(folderId, sealed);
    for (const packed of unpackSegment(opened)) {
      const entry = decodeEntry(packed.data);
      const held = newest.get(entry.id);
      if (!held || entry.version > held.version) newest.set(entry.id, entry);
    }
  }
  return { entries: newest, segments: segments.length };
}

/**
 * Rebuilds a namespace's index from the chain alone: text, keyword terms and vectors are wiped and
 * derived again from the encrypted segments. A forgotten memory stays forgotten.
 */
async function handleRestore(deps: Deps, job: typeof jobs.$inferSelect) {
  const folderId = (job.payload as { folderId: string }).folderId;
  const scope = await loadScope(deps, folderId);
  await updateJob(deps.db, job.id, { status: "running" });
  const models = await modelsFor(deps.db, deps.memoryKeys, deps.env, scope.accountId);
  const { entries, segments } = await readChainEntries(deps, folderId);

  const rows = await deps.db
    .select({ id: memories.id, deletedAt: memories.deletedAt, version: memories.version })
    .from(memories)
    .where(eq(memories.folderId, folderId));
  const known = new Map(rows.map((row) => [row.id, row]));
  const live = [...entries.values()].filter((entry) => !known.get(entry.id)?.deletedAt);
  const vectors = await embedAll(
    models.embedder,
    live.map((entry) => entry.text),
  );

  await deps.db.transaction(async (tx) => {
    let rebuilt = 0;
    let recovered = 0;
    for (const [i, entry] of live.entries()) {
      const vector = vectors[i] ?? null;
      const dates = {
        occurredAt: entry.occurredAt ? new Date(entry.occurredAt) : null,
        expiresAt: entry.expiresAt ? new Date(entry.expiresAt) : null,
        updatedAt: new Date(entry.updatedAt),
      };
      const shared = {
        version: entry.version,
        userId: entry.userId ?? null,
        agentId: entry.agentId ?? null,
        runId: entry.runId ?? null,
        metadata: entry.metadata ?? null,
        categories: entry.categories ?? null,
        entityTerms: blindEntities(deps.memoryKeys, folderId, entry.entities),
        memoryType: entry.memoryType ?? "fact",
        attributedTo: entry.attributedTo ?? null,
        raw: entry.raw ?? false,
        immutable: entry.immutable ?? false,
        sourceObjectId: entry.source?.objectId ?? null,
        sourceKind: entry.source?.kind ?? null,
        sourceLabel: entry.source?.label ?? null,
        sealedText: sealBody(deps.memoryKeys, folderId, {
          text: entry.text,
          entities: entry.entities,
        }),
        dedupeKey: blindDedupeKey(deps.memoryKeys, folderId, entry.text, entry),
        embedding: vector,
        embeddingModel: vector ? (models.embedder?.modelId ?? null) : null,
        termCount: tokenize(entry.text).length,
        ...dates,
      };
      if (known.has(entry.id)) {
        await tx.update(memories).set(shared).where(eq(memories.id, entry.id));
        await writeTerms(tx, deps.memoryKeys, entry.id, folderId, entry.text);
        rebuilt += 1;
      } else {
        const created = await insertRecovered(tx, deps, scope, entry, shared);
        if (created) recovered += 1;
      }
    }
    await updateJob(tx, job.id, {
      status: "finalized",
      result: { indexed: true, restored: live.length, rebuilt, recovered, segments },
    });
  });
}

async function insertRecovered(
  tx: Parameters<Parameters<Deps["db"]["transaction"]>[0]>[0],
  deps: Deps,
  scope: NamespaceScope,
  entry: MemoryEntry,
  shared: Omit<typeof memories.$inferInsert, "accountId" | "spaceId" | "folderId" | "mode">,
): Promise<boolean> {
  const [row] = await tx
    .insert(memories)
    .values({
      id: entry.id,
      accountId: scope.accountId,
      spaceId: scope.spaceId,
      folderId: scope.folderId,
      mode: "assisted",
      createdAt: new Date(entry.createdAt),
      ...shared,
    })
    .onConflictDoNothing()
    .returning({ id: memories.id });
  if (!row) return false;
  await writeTerms(tx, deps.memoryKeys, entry.id, scope.folderId, entry.text);
  if (entry.history?.length) {
    await tx.insert(memoryHistory).values(
      entry.history.map((change) => ({
        memoryId: entry.id,
        event: change.event,
        version: entry.version,
        sealedText: change.text ? deps.memoryKeys.sealRowText(scope.folderId, change.text) : null,
        sealedPrevious: change.previous
          ? deps.memoryKeys.sealRowText(scope.folderId, change.previous)
          : null,
        actor: change.actor ?? null,
        createdAt: new Date(change.at),
      })),
    );
  }
  return true;
}

/**
 * Rewrites what's still alive in half-dead segments, in failed segments, or (past the limit) in
 * the smallest ones, into one new segment, then stops renewing the old ones. Fewer renewals, and
 * forgotten entries really do leave the chain once their old segments expire.
 */
async function handleCompact(deps: Deps, job: typeof jobs.$inferSelect) {
  const folderId = (job.payload as { folderId: string }).folderId;
  await updateJob(deps.db, job.id, { status: "running" });
  const health = await segmentHealth(deps.db, folderId);
  const targets = new Set(
    health.filter((segment) => segment.live * 2 < segment.entries).map((segment) => segment.id),
  );
  if (health.length > COMPACT_ABOVE_SEGMENTS) {
    const smallestFirst = [...health].sort((a, b) => a.bytes - b.bytes);
    const excess = health.length - Math.floor(COMPACT_ABOVE_SEGMENTS / 2);
    for (const segment of smallestFirst.slice(0, excess)) targets.add(segment.id);
  }
  const failed = await deps.db
    .select({ id: memories.id })
    .from(memories)
    .innerJoin(objects, eq(objects.id, memories.segmentId))
    .where(
      and(
        eq(memories.folderId, folderId),
        isNull(memories.deletedAt),
        eq(objects.status, "failed"),
      ),
    );
  const segmentIds = [...targets];
  const moving = segmentIds.length
    ? await deps.db
        .select({ id: memories.id })
        .from(memories)
        .where(and(inArray(memories.segmentId, segmentIds), isNull(memories.deletedAt)))
    : [];
  const memoryIds = [...moving, ...failed].map((row) => row.id);

  await deps.db.transaction(async (tx) => {
    // Old segments go first: they give their quota back for the new one to use.
    await tx
      .update(memories)
      .set({ segmentId: null })
      .where(memoryIds.length ? inArray(memories.id, memoryIds) : sql`false`);
    if (segmentIds.length) {
      await tombstoneObjects(tx, inArray(objects.id, segmentIds) as never);
    }
    await persistMemories(tx, deps.boss, deps.memoryKeys, {
      folderId,
      memoryIds,
      jobId: job.id,
    });
    await updateJob(tx, job.id, {
      result: { indexed: true, compacted: segmentIds.length, moved: memoryIds.length },
      ...(memoryIds.length === 0 ? { status: "finalized" as const } : {}),
    });
  });
  console.log(`[memory] compacted ${segmentIds.length} segments, moved ${memoryIds.length}`);
}

export async function handleMemory(
  deps: Deps,
  queued: JobWithMetadata<MemoryPayload>,
): Promise<void> {
  const { op, jobId } = queued.data;
  const [job] = await deps.db.select().from(jobs).where(eq(jobs.id, jobId));
  if (!job || job.status === "finalized" || job.status === "failed") return;
  const finalAttempt = queued.retryCount >= queued.retryLimit;
  try {
    if (op === "add") await handleAdd(deps, job, finalAttempt);
    else if (op === "import") await handleImport(deps, job);
    else if (op === "restore") await handleRestore(deps, job);
    else await handleCompact(deps, job);
  } catch (error) {
    if (error instanceof MemoryQuotaError) {
      await failMemoryJob(deps, job.id, error.message);
      return;
    }
    if (finalAttempt) await failMemoryJob(deps, job.id, errorText(error));
    else await updateJob(deps.db, job.id, { error: `Retrying: ${errorText(error)}` });
    throw error;
  }
}

async function failMemoryJob(deps: Deps, jobId: string, reason: string) {
  await deps.db.transaction(async (tx) => {
    await tx.delete(memoryInbox).where(eq(memoryInbox.jobId, jobId));
    await updateJob(tx, jobId, { status: "failed", error: reason });
  });
}
