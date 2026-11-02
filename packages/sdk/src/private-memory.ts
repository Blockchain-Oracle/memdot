import { bitswapGet } from "@memdot/chain";
import { SEGMENT_PACK_BYTES } from "@memdot/config";
import { openSegment, openWith, sealSegment, sealTo } from "@memdot/crypto";
import {
  type ChatMessage,
  candidateCount,
  decodeEntry,
  dedupeKey,
  type Embedder,
  ENTITY_BOOST,
  encodeEntry,
  entityCandidates,
  type FilterableMemory,
  type FilterNode,
  type ImportItem,
  isExpired,
  type LlmConfig,
  LOCAL_EMBEDDING_MODEL,
  LocalIndex,
  type MemoryChange,
  type MemoryEntry,
  type MemorySource,
  matchesFilter,
  messageText,
  normalizeEntity,
  type PromptCategory,
  queryTermCount,
  type Ranked,
  rank,
  readSnapshot,
  tokenize,
} from "@memdot/memory-engine";
import type { Context } from "./context.js";
import { MemDotError } from "./errors.js";
import type { JobsApi } from "./jobs.js";
import type { SpacesApi } from "./spaces.js";
import { storeObject } from "./store.js";
import { unwrap } from "./transport.js";
import type { Wallet } from "./wallet.js";

/** Nearby memories shown to the model, so it doesn't write the same fact again. */
const KNOWN_MEMORIES = 10;
/** A namespace past this many segments is worth compacting (P4). */
const COMPACT_ABOVE_SEGMENTS = 32;
/** Texts embedded in one go, to keep the page responsive. */
const EMBED_BATCH = 64;
const fetchDocument = async (url: string) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Couldn't fetch ${url}: ${response.status}`);
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    mime: response.headers.get("content-type")?.split(";")[0] ?? "",
  };
};

/** Loaded only when a model is actually called. */
const llmTools = () => import("@memdot/memory-engine/llm");

const toFilterable = (entry: MemoryEntry): FilterableMemory => ({
  id: entry.id,
  text: entry.text,
  userId: entry.userId,
  agentId: entry.agentId,
  runId: entry.runId,
  createdAt: entry.createdAt,
  updatedAt: entry.updatedAt,
  expiresAt: entry.expiresAt,
  categories: entry.categories,
  metadata: entry.metadata,
});

export interface PrivateAdd {
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
  wallet?: Wallet | undefined;
  wait: boolean;
}

export interface PrivateSearch {
  query: string;
  limit: number;
  threshold: number;
  mode: "hybrid" | "semantic" | "keyword";
  filter?: FilterNode | undefined;
  showExpired: boolean;
  asOf?: Date | undefined;
  rerank: boolean;
}

export interface PrivateDeps {
  ctx: Context;
  spaces: SpacesApi;
  jobs: JobsApi;
  embedder: () => Embedder;
  /** The model Private extraction uses, with the account's own key. */
  llm: () => Promise<LlmConfig | null>;
  settings: (namespaceId: string) => Promise<{
    instructions: string | null;
    categories: PromptCategory[] | null;
  }>;
}

/**
 * A Private namespace, held in memory on this device: nothing but ids and ciphertext reaches
 * MemDot. Segments are read back and opened here; the index is built here; extraction calls the
 * model with the account's own key straight from this device.
 */
export class PrivateNamespace {
  private readonly entries = new Map<string, MemoryEntry>();
  /** Already opened: segments never change, so each is read once. */
  private readonly opened = new Map<string, MemoryEntry[]>();
  private index: LocalIndex | null = null;
  private syncing: Promise<void> | null = null;
  private dirty = 0;

  constructor(
    private readonly deps: PrivateDeps,
    readonly id: string,
    readonly spaceId: string,
  ) {}

  private get ctx() {
    return this.deps.ctx;
  }

  /** Catches up with what other devices wrote; concurrent reads share one trip. */
  ensureLoaded(): Promise<void> {
    this.syncing ??= this.sync().finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private async state() {
    return unwrap(
      this.ctx.transport.api.GET("/v1/namespaces/{id}/private", {
        params: { path: { id: this.id } },
      }),
    );
  }

  private async identities(): Promise<string[]> {
    const space = await this.deps.spaces.raw(this.spaceId);
    return this.ctx.vault.ownedIdentities(this.spaceId, space.keyEpoch);
  }

  private async sync(fromChain = false): Promise<void> {
    if (!this.ctx.vault.unlocked) {
      throw new MemDotError(423, "LOCKED", "Unlock your account to read a Private namespace.");
    }
    const state = await this.state();
    const identities = await this.identities();
    const chain = fromChain ? await this.ctx.chain() : null;
    for (const segment of state.segments) {
      if (this.opened.has(segment.cid) || !segment.cid) continue;
      const sealed = chain
        ? await bitswapGet(chain.client, segment.cid)
        : await this.ctx.transport.bytes(`/v1/cids/${segment.cid}`);
      const packed = await openSegment(sealed, identities);
      this.opened.set(
        segment.cid,
        packed.map((entry) => decodeEntry(entry.data)),
      );
    }

    const wanted = new Map(state.live.map((row) => [row.id, row.version]));
    this.entries.clear();
    for (const list of this.opened.values()) {
      for (const entry of list) {
        if (wanted.get(entry.id) === entry.version) this.entries.set(entry.id, entry);
      }
    }
    if (!this.index) {
      await this.buildIndex(state.snapshot, identities);
      return;
    }
    const index = this.index;
    const changed = [...this.entries.values()].filter(
      (entry) => index.version(entry.id) !== entry.version,
    );
    for (const id of index.ids()) if (!this.entries.has(id)) index.remove(id);
    for (const entry of changed) index.put(entry.id, entry.version, entry.text);
    await this.embedInto(changed);
  }

  private async buildIndex(snapshot: { cid: string } | null, identities: string[]): Promise<void> {
    const { modelId, dimensions } = this.deps.embedder();
    const index = new LocalIndex(modelId, LOCAL_EMBEDDING_MODEL.dtype, dimensions);
    let vectors: ReturnType<typeof readSnapshot> = null;
    if (snapshot?.cid) {
      // A bad snapshot only costs time: everything can be embedded again from the segments.
      try {
        const sealed = await this.ctx.transport.bytes(`/v1/cids/${snapshot.cid}`);
        vectors = readSnapshot(await openWith(sealed, identities, "the index snapshot"), {
          modelId,
          dtype: LOCAL_EMBEDDING_MODEL.dtype,
          dimensions,
        });
      } catch (error) {
        console.warn("[memdot] index snapshot skipped:", error);
      }
    }
    const missing: MemoryEntry[] = [];
    for (const entry of this.entries.values()) {
      const held = vectors?.get(entry.id);
      if (held?.version === entry.version) {
        index.put(entry.id, entry.version, entry.text, held.vector);
      } else {
        index.put(entry.id, entry.version, entry.text);
        missing.push(entry);
      }
    }
    this.index = index;
    await this.embedInto(missing);
  }

  private async embedInto(entries: MemoryEntry[]): Promise<void> {
    const embedder = this.deps.embedder();
    for (let start = 0; start < entries.length; start += EMBED_BATCH) {
      const batch = entries.slice(start, start + EMBED_BATCH);
      const vectors = await embedder.embed(
        batch.map((entry) => entry.text),
        "document",
      );
      batch.forEach((entry, i) => {
        const vector = vectors[i];
        if (vector) this.index?.setVector(entry.id, vector);
      });
    }
  }

  private readableEntries(options: {
    filter?: FilterNode | undefined;
    showExpired: boolean;
    asOf?: Date | undefined;
  }): MemoryEntry[] {
    const at = options.asOf ?? new Date();
    return [...this.entries.values()].filter((entry) => {
      if (!options.showExpired && isExpired(entry.expiresAt, at)) return false;
      if (
        options.asOf &&
        Date.parse(entry.occurredAt ?? entry.createdAt) > options.asOf.getTime()
      ) {
        return false;
      }
      return options.filter ? matchesFilter(toFilterable(entry), options.filter) : true;
    });
  }

  async list(options: {
    filter?: FilterNode | undefined;
    showExpired: boolean;
  }): Promise<MemoryEntry[]> {
    await this.ensureLoaded();
    return this.readableEntries(options).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async get(id: string): Promise<MemoryEntry | null> {
    await this.ensureLoaded();
    return this.entries.get(id) ?? null;
  }

  async search(input: PrivateSearch): Promise<(MemoryEntry & Ranked & { rerankScore?: number })[]> {
    await this.ensureLoaded();
    const index = this.index as LocalIndex;
    const allowed = new Set(this.readableEntries(input).map((entry) => entry.id));
    const allow = (id: string) => allowed.has(id);
    const fetch = candidateCount(input.limit);

    const semantic = new Map<string, number>();
    if (input.mode !== "keyword") {
      const [vector] = await this.deps.embedder().embed([input.query], "query");
      if (vector) {
        for (const hit of index.semantic(vector, fetch, allow)) semantic.set(hit.id, hit.score);
      }
    }
    const keyword = new Map<string, number>();
    if (input.mode !== "semantic") {
      for (const hit of index.keyword(tokenize(input.query), fetch, allow)) {
        keyword.set(hit.id, hit.score);
      }
    }
    const named = new Set(entityCandidates(input.query));
    const ranked = rank(
      [...new Set([...semantic.keys(), ...keyword.keys()])].map((id) => ({
        id,
        semantic: semantic.get(id) ?? null,
        keyword: keyword.get(id) ?? 0,
        entity: this.entries.get(id)?.entities?.some((name) => named.has(normalizeEntity(name)))
          ? ENTITY_BOOST
          : 0,
      })),
      {
        queryTerms: queryTermCount(input.query),
        limit: input.limit,
        threshold: input.threshold,
        mode: input.mode,
      },
    );
    const results = ranked.map((hit) => ({ ...(this.entries.get(hit.id) as MemoryEntry), ...hit }));
    if (input.rerank && results.length > 1) {
      const config = await this.deps.llm();
      if (config) {
        try {
          const { languageModel, rerankTexts } = await llmTools();
          const scores = await rerankTexts(
            languageModel(config),
            input.query,
            results.map((result) => result.text),
          );
          return results
            .map((result, i) => ({ ...result, rerankScore: scores[i] as number }))
            .sort((a, b) => b.rerankScore - a.rerankScore);
        } catch (error) {
          console.warn("[memdot] rerank skipped:", error);
        }
      }
    }
    return results;
  }

  /** The facts in this conversation, as drafts ready to store. */
  private async draftsFor(input: PrivateAdd): Promise<{
    drafts: Partial<MemoryEntry>[];
    note: string | null;
  }> {
    const asWritten = () =>
      input.messages.flatMap((message): Partial<MemoryEntry>[] => {
        const text = messageText(message).trim();
        if (!text || message.role === "system") return [];
        return [{ text, attributedTo: message.role === "assistant" ? "assistant" : "user" }];
      });
    if (!input.infer) return { drafts: asWritten(), note: null };

    const config = await this.deps.llm();
    if (!config) {
      return {
        drafts: asWritten().map((draft) => ({ ...draft, raw: true })),
        note: "No model is set for Private memory, so this was stored as written.",
      };
    }
    const { extractMemories, languageModel, proceduralRecord } = await llmTools();
    const model = languageModel(config);
    if (input.procedural) {
      const text = await proceduralRecord(model, input.messages, fetchDocument, input.prompt);
      return { drafts: [{ text, memoryType: "procedural" }], note: null };
    }
    const settings = await this.deps.settings(this.id);
    const nearby = await this.search({
      query: input.messages.map(messageText).join("\n").slice(0, 2_000),
      limit: KNOWN_MEMORIES,
      threshold: 0,
      mode: "semantic",
      showExpired: true,
      rerank: false,
    }).catch(() => []);
    try {
      const extracted = await extractMemories(model, {
        messages: input.messages,
        known: nearby.map((hit) => hit.text),
        instructions: input.prompt ?? settings.instructions,
        categories: input.categories ?? settings.categories,
        observedAt: input.occurredAt ? new Date(input.occurredAt) : new Date(),
        agentScoped: Boolean(input.agentId && !input.userId),
        fetchDocument,
      });
      return {
        drafts: extracted.map((memory) => ({
          text: memory.text,
          entities: memory.entities,
          categories: memory.categories,
          attributedTo: memory.attributed_to,
        })),
        note: null,
      };
    } catch (error) {
      console.warn("[memdot] extraction failed, keeping the raw text:", error);
      return {
        drafts: asWritten().map((draft) => ({ ...draft, raw: true })),
        note: "The model couldn't read this, so it was stored as written.",
      };
    }
  }

  async add(input: PrivateAdd) {
    await this.ensureLoaded();
    const { drafts, note } = await this.draftsFor(input);
    const seen = new Set([...this.entries.values()].map((entry) => dedupeKey(entry.text, entry)));
    const now = new Date().toISOString();
    let duplicates = 0;
    const fresh: MemoryEntry[] = [];
    for (const draft of drafts) {
      const scope = {
        ...(input.userId ? { userId: input.userId } : {}),
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.runId ? { runId: input.runId } : {}),
      };
      const text = draft.text as string;
      const key = dedupeKey(text, scope);
      if (seen.has(key)) {
        duplicates += 1;
        continue;
      }
      seen.add(key);
      const change: MemoryChange = {
        event: "ADD",
        text,
        previous: null,
        at: now,
        ...(input.actor ? { actor: input.actor } : {}),
      };
      fresh.push({
        v: 1,
        id: crypto.randomUUID(),
        version: 1,
        memoryType: "fact",
        ...draft,
        text,
        ...scope,
        ...(input.metadata ? { metadata: input.metadata } : {}),
        ...(input.source ? { source: input.source } : {}),
        ...(input.immutable ? { immutable: true } : {}),
        ...(input.occurredAt ? { occurredAt: input.occurredAt } : {}),
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
        createdAt: now,
        updatedAt: now,
        history: [change],
      });
    }
    const write = fresh.length ? await this.writeEntries(fresh, input.wallet, input.wait) : null;
    return { entries: fresh, duplicates, note, jobId: write?.jobId ?? null };
  }

  /** Stores imported memories as written, one segment per pack, the same fact only once. */
  async importItems(
    items: ImportItem[],
    source: string,
    wallet: Wallet | undefined,
  ): Promise<{ imported: number; duplicates: number }> {
    await this.ensureLoaded();
    const seen = new Set([...this.entries.values()].map((entry) => dedupeKey(entry.text, entry)));
    const now = new Date().toISOString();
    const fresh: MemoryEntry[] = [];
    let duplicates = 0;
    for (const item of items) {
      const key = dedupeKey(item.text, item);
      if (seen.has(key)) {
        duplicates += 1;
        continue;
      }
      seen.add(key);
      fresh.push({
        v: 1,
        id: crypto.randomUUID(),
        version: 1,
        memoryType: "fact",
        text: item.text,
        ...(item.userId ? { userId: item.userId } : {}),
        ...(item.agentId ? { agentId: item.agentId } : {}),
        ...(item.runId ? { runId: item.runId } : {}),
        ...(item.metadata ? { metadata: item.metadata } : {}),
        ...(item.categories ? { categories: item.categories } : {}),
        ...(item.expiresAt ? { expiresAt: item.expiresAt } : {}),
        source: { kind: "import", label: source },
        createdAt: item.createdAt ?? now,
        updatedAt: item.updatedAt ?? now,
        history: [{ event: "ADD", text: item.text, previous: null, at: now }],
      });
    }
    let pack: MemoryEntry[] = [];
    let bytes = 0;
    for (const entry of fresh) {
      const size = encodeEntry(entry).length;
      if (pack.length > 0 && bytes + size > SEGMENT_PACK_BYTES) {
        await this.writeEntries(pack, wallet, false);
        pack = [];
        bytes = 0;
      }
      pack.push(entry);
      bytes += size;
    }
    if (pack.length > 0) await this.writeEntries(pack, wallet, false);
    return { imported: fresh.length, duplicates };
  }

  /** One sealed segment on V3, then the ids at MemDot. Reused by add, update and compaction. */
  private async writeEntries(
    entries: MemoryEntry[],
    wallet: Wallet | undefined,
    wait: boolean,
  ): Promise<{ jobId: string; segmentId: string }> {
    const packed = entries.map((entry) => ({
      id: entry.id,
      kind: "memory" as const,
      data: encodeEntry(entry),
    }));
    const bytes = packed.reduce((sum, entry) => sum + entry.data.length, 0);
    if (bytes > SEGMENT_PACK_BYTES) {
      throw new MemDotError(400, "TOO_LARGE", "Write fewer memories at a time.");
    }
    const space = await this.deps.spaces.raw(this.spaceId);
    const recipient = this.ctx.vault.sealTo(this.spaceId, space.keyEpoch);
    const sealed = await sealSegment(packed, recipient);
    const declared = await storeObject(this.ctx, {
      kind: "segment",
      spaceId: this.spaceId,
      folderId: this.id,
      keyEpoch: space.keyEpoch,
      sizeBytes: sealed.length,
      root: sealed,
      skipRecord: true,
      ...(wallet ? { wallet } : {}),
    });
    await unwrap(
      this.ctx.transport.api.POST("/v1/namespaces/{id}/private/entries", {
        params: { path: { id: this.id } },
        body: {
          segment_id: declared.object.id,
          entries: entries.map((entry) => ({
            id: entry.id,
            version: entry.version,
            ...(entry.source?.objectId ? { source_object_id: entry.source.objectId } : {}),
          })),
        },
      }),
    );
    if (wait) await this.deps.jobs.waitFor(declared.job.id);

    // Reading this segment back would only return what's already here.
    this.opened.set(declared.object.cid as string, entries);
    await this.embedLocally(entries);
    this.dirty += entries.length;
    return { jobId: declared.job.id, segmentId: declared.object.id };
  }

  private async embedLocally(entries: MemoryEntry[]): Promise<void> {
    for (const entry of entries) {
      this.entries.set(entry.id, entry);
      this.index?.put(entry.id, entry.version, entry.text);
    }
    await this.embedInto(entries);
  }

  async update(
    id: string,
    change: {
      text?: string | undefined;
      metadata?: Record<string, unknown> | undefined;
      expiresAt?: string | null | undefined;
    },
    options: { wallet?: Wallet | undefined; actor?: string | undefined; wait: boolean },
  ): Promise<MemoryEntry> {
    await this.ensureLoaded();
    const current = this.entries.get(id);
    if (!current) throw new MemDotError(404, "NOT_FOUND", "Memory not found.");
    if (current.immutable) {
      throw new MemDotError(409, "IMMUTABLE", "This memory is immutable, so it can't change.");
    }
    const now = new Date().toISOString();
    const text = change.text ?? current.text;
    const { expiresAt: _dropped, ...rest } = current;
    const next: MemoryEntry = {
      ...rest,
      text,
      version: current.version + 1,
      updatedAt: now,
      ...(change.metadata ? { metadata: { ...current.metadata, ...change.metadata } } : {}),
      ...(change.expiresAt !== undefined
        ? change.expiresAt
          ? { expiresAt: change.expiresAt }
          : {}
        : current.expiresAt
          ? { expiresAt: current.expiresAt }
          : {}),
      // The old entity names described the old text.
      ...(text !== current.text ? { entities: [] } : {}),
      history: [
        ...(current.history ?? []),
        {
          event: "UPDATE",
          text,
          previous: current.text,
          at: now,
          ...(options.actor ? { actor: options.actor } : {}),
        },
      ],
    };
    await this.writeEntries([next], options.wallet, options.wait);
    return next;
  }

  /** Drops forgotten memories from what this device holds; MemDot has already marked them. */
  forget(ids: string[]): void {
    for (const id of ids) {
      this.entries.delete(id);
      this.index?.remove(id);
    }
  }

  /**
   * Rewrites what's still alive in mostly dead segments (or, past the limit, the smallest ones)
   * into one new segment and stops renewing the old ones. Runs here, because only this device can
   * read them. Spends tPOT in a self-signed space, so it runs when asked.
   */
  async compact(options: { wallet?: Wallet | undefined } = {}): Promise<{
    segments: number;
    moved: number;
  }> {
    await this.ensureLoaded();
    const state = await this.state();
    const liveBySegment = new Map<string, number>();
    for (const row of state.live) {
      if (row.segment_id) {
        liveBySegment.set(row.segment_id, (liveBySegment.get(row.segment_id) ?? 0) + 1);
      }
    }
    const deadHeavy = state.segments.filter(
      (segment) => (liveBySegment.get(segment.id) ?? 0) * 2 < segment.entries,
    );
    const excess = state.segments.length - Math.floor(COMPACT_ABOVE_SEGMENTS / 2);
    const merging =
      state.segments.length > COMPACT_ABOVE_SEGMENTS
        ? [...state.segments]
            .sort((a, b) => (liveBySegment.get(a.id) ?? 0) - (liveBySegment.get(b.id) ?? 0))
            .slice(0, excess)
        : [];
    const targets = new Map([...deadHeavy, ...merging].map((segment) => [segment.id, segment]));
    if (targets.size === 0) return { segments: 0, moved: 0 };

    const moving = state.live
      .filter((row) => row.segment_id && targets.has(row.segment_id))
      .flatMap((row) => {
        const entry = this.entries.get(row.id);
        return entry ? [entry] : [];
      });
    if (moving.length > 0) {
      await this.writeEntries(moving, options.wallet, true);
    }
    for (const segment of targets.values()) {
      await unwrap(
        this.ctx.transport.api.DELETE("/v1/objects/{id}", {
          params: { path: { id: segment.id } },
        }),
      );
      await this.ctx.registry.tombstoneObject(this.spaceId, segment.cid);
      this.opened.delete(segment.cid);
    }
    return { segments: targets.size, moved: moving.length };
  }

  /** Whether writes have earned a new snapshot or a compaction by now. */
  get unsaved(): number {
    return this.dirty;
  }

  /** Stores the index, encrypted, on V3, so another device can start without embedding it all. */
  async saveIndex(options: { wallet?: Wallet | undefined; wait: boolean }): Promise<string> {
    await this.ensureLoaded();
    const previous = (await this.state()).snapshot;
    const snapshot = (this.index as LocalIndex).toSnapshot(new Date().toISOString());
    const space = await this.deps.spaces.raw(this.spaceId);
    const sealed = await sealTo(snapshot, [this.ctx.vault.sealTo(this.spaceId, space.keyEpoch)]);
    const declared = await storeObject(this.ctx, {
      kind: "index_snapshot",
      spaceId: this.spaceId,
      folderId: this.id,
      keyEpoch: space.keyEpoch,
      sizeBytes: sealed.length,
      root: sealed,
      ...(options.wallet ? { wallet: options.wallet } : {}),
    });
    if (options.wait) await this.deps.jobs.waitFor(declared.job.id);
    if (previous) {
      await unwrap(
        this.ctx.transport.api.DELETE("/v1/objects/{id}", {
          params: { path: { id: previous.id } },
        }),
      );
    }
    this.dirty = 0;
    return declared.object.cid as string;
  }

  /** Throws away everything this device holds and rebuilds it from the chain alone. */
  async restore(): Promise<{ restored: number; segments: number }> {
    this.entries.clear();
    this.opened.clear();
    this.index = null;
    await this.sync(true);
    return { restored: this.entries.size, segments: this.opened.size };
  }

  async summary(options: { filter?: FilterNode | undefined }): Promise<string> {
    const config = await this.deps.llm();
    if (!config)
      throw new MemDotError(409, "MODEL_REQUIRED", "Set a model for Private memory first.");
    const entries = await this.list({ ...options, showExpired: false });
    const { languageModel, summarizeMemories } = await llmTools();
    return entries.length
      ? summarizeMemories(
          languageModel(config),
          entries.map((entry) => entry.text),
        )
      : "";
  }
}
