import { openWith, sealTo } from "@memdot/crypto";
import {
  type ChatMessage,
  type Embedder,
  FilterError,
  type FilterNode,
  type LlmConfig,
  type MemoryEntry,
  normalizeMessages,
  type PromptCategory,
  parseFilter,
  parseMemoryImport,
} from "@memdot/memory-engine";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import type { Context, Schemas } from "./context.js";
import { MemDotError } from "./errors.js";
import type { JobsApi } from "./jobs.js";
import { localEmbedder } from "./local-embedder.js";
import { PrivateNamespace } from "./private-memory.js";
import type { paths } from "./schema.js";
import type { FoldersApi, SpacesApi } from "./spaces.js";
import { fromBase64, openText, toBase64 } from "./spaces.js";
import { unwrap } from "./transport.js";
import type { Wallet } from "./wallet.js";

const DEFAULT_TOP_K = 10;
const DEFAULT_THRESHOLD = 0.1;
const DEFAULT_PAGE = 50;
const EVENT_POLL_MS = 500;
/** How long `add` waits for a memory to become searchable before returning what it knows. */
const INDEX_TIMEOUT_MS = 120_000;
/** Writes before a Private namespace's index is worth saving again. */
const SNAPSHOT_EVERY = 100;

type RawMemory = Schemas["Memory"];
type RawScored = Schemas["ScoredMemory"];
export type MemoryEvent = Schemas["MemoryEvent"];

export type MemoryMode = "private" | "assisted";

/** A memory, whichever mode it's in. */
export interface Memory {
  id: string;
  memory: string;
  namespaceId: string;
  userId: string | null;
  agentId: string | null;
  runId: string | null;
  metadata: Record<string, unknown> | null;
  categories: string[] | null;
  memoryType: string | null;
  attributedTo: string | null;
  source: { kind: string; objectId: string | null; label: string | null } | null;
  raw: boolean;
  immutable: boolean;
  version: number;
  feedback: string | null;
  expirationDate: string | null;
  occurredAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Where the current version is stored. Null while it's on its way, or until it's looked up. */
  segment: { id: string; cid: string; status: string; block: number | null } | null;
  mode: MemoryMode;
}

export interface ScoredMemory extends Memory {
  score: number;
  scoreBreakdown: { semantic: number; bm25: number; entity: number };
  rerankScore?: number;
}

export interface Namespace {
  id: string;
  spaceId: string;
  /** Decrypted on this device; null while locked. */
  name: string | null;
  mode: MemoryMode;
  totalMemories: number;
  segments: number;
  lastWrite: string | null;
  createdAt: string;
}

export interface MemoryScope {
  userId?: string;
  agentId?: string;
  runId?: string;
}

export interface AddOptions extends MemoryScope {
  namespaceId?: string;
  metadata?: Record<string, unknown>;
  expirationDate?: string | null;
  /** When this happened; relative dates in the text count from it. */
  timestamp?: number | string;
  /** Let a model distill facts (default), or store each message as written. */
  infer?: boolean;
  /** An agent's working record, stored as one memory. Needs `agentId`. */
  memoryType?: "procedural_memory";
  /** Custom instructions for this call, over the namespace's own. */
  prompt?: string;
  categories?: PromptCategory[];
  immutable?: boolean;
  /** The file this was read from. Deleting the file deletes these memories. */
  source?: { objectId?: string; label?: string };
  /** Self-signed spaces: the wallet that signs the store (Private namespaces). */
  wallet?: Wallet;
  /**
   * "indexed": return once it's searchable (default). "chain": wait until finalized on V3.
   * false: return at once with the event to follow.
   */
  wait?: "indexed" | "chain" | false;
}

export interface AddResult {
  /** Follow it with `memories.event`, or `jobs.waitFor` for each step. Null if nothing was written. */
  eventId: string | null;
  status: MemoryEvent["status"];
  namespaceId: string;
  results: { id: string; memory: string | null; event: string }[];
  duplicates: number;
  /** Why this was stored differently than asked. */
  note: string | null;
}

export interface SearchOptions {
  namespaceId?: string;
  filters?: Record<string, unknown>;
  topK?: number;
  /** Minimum semantic similarity; 0 turns it off. */
  threshold?: number;
  mode?: "hybrid" | "semantic" | "keyword";
  rerank?: boolean;
  showExpired?: boolean;
  /** Search as of this moment. */
  referenceDate?: number | string;
}

export interface ListOptions {
  namespaceId?: string;
  filters?: Record<string, unknown>;
  showExpired?: boolean;
  cursor?: string;
  pageSize?: number;
}

export interface MemoryUpdate {
  text?: string;
  metadata?: Record<string, unknown>;
  expirationDate?: string | null;
}

export interface HistoryEvent {
  event: "ADD" | "UPDATE" | "DELETE";
  oldMemory: string | null;
  newMemory: string | null;
  actor: string | null;
  createdAt: string;
}

export interface Entity {
  id: string;
  type: "user" | "agent" | "run";
  totalMemories: number;
  createdAt: string;
  updatedAt: string;
  namespaceId: string;
}

const fromWire = (raw: RawMemory): Memory => ({
  id: raw.id,
  memory: raw.memory,
  namespaceId: raw.namespace_id,
  userId: raw.user_id,
  agentId: raw.agent_id,
  runId: raw.run_id,
  metadata: raw.metadata as Record<string, unknown> | null,
  categories: raw.categories,
  memoryType: raw.memory_type,
  attributedTo: raw.attributed_to,
  source: raw.source
    ? { kind: raw.source.kind, objectId: raw.source.object_id, label: raw.source.label }
    : null,
  raw: raw.raw,
  immutable: raw.immutable,
  version: raw.version,
  feedback: raw.feedback,
  expirationDate: raw.expiration_date,
  occurredAt: raw.occurred_at,
  createdAt: raw.created_at,
  updatedAt: raw.updated_at,
  segment: raw.segment,
  mode: "assisted",
});

const fromEntry = (entry: MemoryEntry, namespaceId: string): Memory => ({
  id: entry.id,
  memory: entry.text,
  namespaceId,
  userId: entry.userId ?? null,
  agentId: entry.agentId ?? null,
  runId: entry.runId ?? null,
  metadata: entry.metadata ?? null,
  categories: entry.categories ?? null,
  memoryType: entry.memoryType ?? null,
  attributedTo: entry.attributedTo ?? null,
  source: entry.source
    ? {
        kind: entry.source.kind,
        objectId: entry.source.objectId ?? null,
        label: entry.source.label ?? null,
      }
    : null,
  raw: entry.raw ?? false,
  immutable: entry.immutable ?? false,
  version: entry.version,
  feedback: null,
  expirationDate: entry.expiresAt ?? null,
  occurredAt: entry.occurredAt ?? null,
  createdAt: entry.createdAt,
  updatedAt: entry.updatedAt,
  segment: null,
  mode: "private",
});

function parseFilters(filters: Record<string, unknown> | undefined): FilterNode | undefined {
  if (!filters || Object.keys(filters).length === 0) return undefined;
  try {
    return parseFilter(filters);
  } catch (error) {
    if (error instanceof FilterError) throw new MemDotError(400, "BAD_FILTER", error.message);
    throw error;
  }
}

const expiry = (value: string | null | undefined) => {
  if (!value) return value;
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T23:59:59.999Z`
    : new Date(value).toISOString();
};
const when = (value: number | string) =>
  typeof value === "number" ? new Date(value * 1000) : new Date(value);

type ModelsChange = NonNullable<
  paths["/v1/configure"]["put"]["requestBody"]
>["content"]["application/json"];

/** What a device keeps for Private memory: the model and key it extracts with. */
interface PrivateSettings {
  llm?: LlmConfig;
}

/**
 * Memories, in the same verbs in both modes. Assisted namespaces go through the API, which can
 * read them. Private ones run entirely here: only ids and ciphertext reach MemDot.
 */
export class MemoriesApi {
  private readonly privateNamespaces = new Map<string, PrivateNamespace>();
  private readonly namespaceList = new Map<string, Schemas["Namespace"]>();
  private embedder: Embedder | null;
  private privateSettings: PrivateSettings | null | undefined;

  constructor(
    private readonly ctx: Context,
    private readonly spaces: SpacesApi,
    private readonly folders: FoldersApi,
    private readonly jobs: JobsApi,
    embedder?: Embedder,
  ) {
    this.embedder = embedder ?? null;
    ctx.vault.subscribe(() => {
      if (ctx.vault.unlocked) return;
      this.privateNamespaces.clear();
      this.privateSettings = undefined;
    });
  }

  private localEmbedder(): Embedder {
    this.embedder ??= localEmbedder();
    return this.embedder;
  }

  // ── Namespaces ──────────────────────────────────────────────────────────────────────────────

  private async rawNamespaces(spaceId?: string) {
    const { results } = await unwrap(
      this.ctx.transport.api.GET("/v1/namespaces", {
        params: { query: spaceId ? { space_id: spaceId } : {} },
      }),
    );
    for (const row of results) this.namespaceList.set(row.id, row);
    return results;
  }

  async namespaces(spaceId?: string): Promise<Namespace[]> {
    const rows = await this.rawNamespaces(spaceId);
    return Promise.all(
      rows.map(async (row) => {
        const identities = this.ctx.vault.unlocked
          ? this.ctx.vault.ownedIdentities(row.space_id, row.key_epoch)
          : [];
        return {
          id: row.id,
          spaceId: row.space_id,
          name: await openText(row.encrypted_name, identities),
          mode: row.mode,
          totalMemories: row.total_memories,
          segments: row.segments,
          lastWrite: row.last_write,
          createdAt: row.created_at,
        };
      }),
    );
  }

  /** A namespace is a folder in memory mode. Its mode is fixed: changing it means a new one. */
  async createNamespace(input: {
    spaceId: string;
    name: string;
    mode: MemoryMode;
  }): Promise<Namespace> {
    const folder = await this.folders.create(input.spaceId, {
      name: input.name,
      memoryMode: input.mode,
    });
    return {
      id: folder.id,
      spaceId: folder.spaceId,
      name: input.name,
      mode: input.mode,
      totalMemories: 0,
      segments: 0,
      lastWrite: null,
      createdAt: folder.createdAt,
    };
  }

  private async namespaceRow(id: string) {
    const cached = this.namespaceList.get(id);
    if (cached) return cached;
    await this.rawNamespaces();
    const row = this.namespaceList.get(id);
    if (!row) throw new MemDotError(404, "NOT_FOUND", "Namespace not found.");
    return row;
  }

  private privateOf(namespace: { id: string; space_id: string }): PrivateNamespace {
    let held = this.privateNamespaces.get(namespace.id);
    if (!held) {
      held = new PrivateNamespace(
        {
          ctx: this.ctx,
          spaces: this.spaces,
          jobs: this.jobs,
          embedder: () => this.localEmbedder(),
          llm: () => this.privateLlm(),
          settings: (id) => this.openSettings(id),
        },
        namespace.id,
        namespace.space_id,
      );
      this.privateNamespaces.set(namespace.id, held);
    }
    return held;
  }

  /** Private, or Assisted handled by the API. No id: the API picks the caller's default. */
  private async route(namespaceId: string | undefined): Promise<PrivateNamespace | null> {
    if (!namespaceId) return null;
    const row = await this.namespaceRow(namespaceId);
    return row.mode === "private" ? this.privateOf(row) : null;
  }

  async settings(namespaceId: string): Promise<{
    customInstructions: string | null;
    categories: PromptCategory[] | null;
  }> {
    const opened = await this.openSettings(namespaceId);
    return { customInstructions: opened.instructions, categories: opened.categories };
  }

  private async openSettings(namespaceId: string) {
    const row = await unwrap(
      this.ctx.transport.api.GET("/v1/namespaces/{id}/settings", {
        params: { path: { id: namespaceId } },
      }),
    );
    if (row.sealed) {
      const text = await openWith(
        fromBase64(row.sealed),
        this.ctx.vault.identity(),
        "the settings",
      );
      const settings = JSON.parse(new TextDecoder().decode(text)) as {
        instructions: string | null;
        categories: PromptCategory[] | null;
      };
      return settings;
    }
    return {
      instructions: row.custom_instructions,
      categories: row.categories as PromptCategory[] | null,
    };
  }

  /** Assisted: the server reads these to extract. Private: sealed here, and only kept there. */
  async setSettings(
    namespaceId: string,
    settings: { customInstructions: string | null; categories: PromptCategory[] | null },
  ): Promise<void> {
    const row = await this.namespaceRow(namespaceId);
    const body =
      row.mode === "private"
        ? {
            sealed: toBase64(
              await sealTo(
                utf8ToBytes(
                  JSON.stringify({
                    instructions: settings.customInstructions,
                    categories: settings.categories,
                  }),
                ),
                [this.ctx.vault.recipient()],
              ),
            ),
          }
        : {
            custom_instructions: settings.customInstructions,
            categories: settings.categories,
          };
    await unwrap(
      this.ctx.transport.api.PUT("/v1/namespaces/{id}/settings", {
        params: { path: { id: namespaceId } },
        body,
      }),
    );
  }

  // ── The model Private namespaces use ────────────────────────────────────────────────────────

  private async loadPrivateSettings(): Promise<PrivateSettings | null> {
    if (this.privateSettings !== undefined) return this.privateSettings;
    if (!this.ctx.vault.unlocked) return null;
    const config = await unwrap(this.ctx.transport.api.GET("/v1/configure"));
    this.privateSettings = config.private_sealed
      ? (JSON.parse(
          new TextDecoder().decode(
            await openWith(
              fromBase64(config.private_sealed),
              this.ctx.vault.identity(),
              "your private settings",
            ),
          ),
        ) as PrivateSettings)
      : null;
    return this.privateSettings;
  }

  private async privateLlm(): Promise<LlmConfig | null> {
    return (await this.loadPrivateSettings())?.llm ?? null;
  }

  /** Whether a Private model is set, without showing its key. */
  async privateModel(): Promise<Pick<LlmConfig, "provider" | "model" | "baseUrl"> | null> {
    const llm = await this.privateLlm();
    if (!llm) return null;
    return {
      provider: llm.provider,
      model: llm.model,
      ...(llm.baseUrl ? { baseUrl: llm.baseUrl } : {}),
    };
  }

  /**
   * Sets the model Private namespaces extract with. The key is sealed here to this account's own
   * key before it's saved, so MemDot can't read it, and every device you unlock can.
   */
  async setPrivateModel(llm: LlmConfig | null): Promise<void> {
    const settings: PrivateSettings = llm ? { llm } : {};
    const sealed = llm
      ? toBase64(await sealTo(utf8ToBytes(JSON.stringify(settings)), [this.ctx.vault.recipient()]))
      : null;
    await unwrap(this.ctx.transport.api.PUT("/v1/configure", { body: { private_sealed: sealed } }));
    this.privateSettings = llm ? settings : null;
  }

  /** The models Assisted namespaces use. Keys are never returned. */
  configuration() {
    return unwrap(this.ctx.transport.api.GET("/v1/configure"));
  }

  /** Chooses this account's models for Assisted namespaces. null goes back to MemDot's. */
  setModels(change: ModelsChange) {
    return unwrap(this.ctx.transport.api.PUT("/v1/configure", { body: change }));
  }

  /** Sends one short request to each configured model. */
  testModels() {
    return unwrap(this.ctx.transport.api.POST("/v1/configure/test"));
  }

  /** Drafts custom instructions from a description of what you're building. */
  async generateInstructions(useCase: string, options: { namespaceId?: string } = {}) {
    const row = options.namespaceId ? await this.namespaceRow(options.namespaceId) : null;
    if (row?.mode === "private") {
      const llm = await this.privateLlm();
      if (!llm)
        throw new MemDotError(409, "MODEL_REQUIRED", "Set a model for Private memory first.");
      const { generateInstructions, languageModel } = await import("@memdot/memory-engine/llm");
      return generateInstructions(languageModel(llm), useCase);
    }
    return unwrap(
      this.ctx.transport.api.POST("/v1/generate-instructions", { body: { use_case: useCase } }),
    );
  }

  // ── Remember ────────────────────────────────────────────────────────────────────────────────

  /** Remembers a string or chat messages. At least one of userId, agentId or runId is required. */
  async add(
    messages: string | ChatMessage | ChatMessage[],
    options: AddOptions,
  ): Promise<AddResult> {
    if (!options.userId && !options.agentId && !options.runId) {
      throw new MemDotError(
        400,
        "SCOPE_REQUIRED",
        "Give at least one of userId, agentId or runId.",
      );
    }
    const held = await this.route(options.namespaceId);
    if (held) return this.addPrivate(held, messages, options);

    const accepted = await unwrap(
      this.ctx.transport.api.POST("/v1/memories", {
        body: {
          messages: normalizeMessages(messages),
          infer: options.infer ?? true,
          ...(options.namespaceId ? { namespace_id: options.namespaceId } : {}),
          ...(options.userId ? { user_id: options.userId } : {}),
          ...(options.agentId ? { agent_id: options.agentId } : {}),
          ...(options.runId ? { run_id: options.runId } : {}),
          ...(options.metadata ? { metadata: options.metadata } : {}),
          ...(options.expirationDate !== undefined
            ? { expiration_date: options.expirationDate }
            : {}),
          ...(options.timestamp !== undefined ? { timestamp: options.timestamp } : {}),
          ...(options.memoryType ? { memory_type: options.memoryType } : {}),
          ...(options.prompt ? { prompt: options.prompt } : {}),
          ...(options.categories
            ? {
                custom_categories: options.categories.map(({ name, description }) => ({
                  [name]: description ?? "",
                })),
              }
            : {}),
          ...(options.immutable ? { immutable: true } : {}),
          ...(options.source
            ? {
                source: {
                  ...(options.source.objectId ? { object_id: options.source.objectId } : {}),
                  ...(options.source.label ? { label: options.source.label } : {}),
                },
              }
            : {}),
        },
      }),
    );
    const base = {
      eventId: accepted.event_id,
      namespaceId: accepted.namespace_id,
    };
    if (options.wait === false) {
      return { ...base, status: accepted.status, results: [], duplicates: 0, note: null };
    }
    const event = await this.waitForEvent(accepted.event_id, options.wait ?? "indexed");
    return {
      ...base,
      status: event.status,
      results: event.results,
      duplicates: event.duplicates,
      note: event.note,
    };
  }

  private async addPrivate(
    held: PrivateNamespace,
    messages: string | ChatMessage | ChatMessage[],
    options: AddOptions,
  ): Promise<AddResult> {
    const written = await held.add({
      messages: normalizeMessages(messages),
      userId: options.userId,
      agentId: options.agentId,
      runId: options.runId,
      metadata: options.metadata,
      expiresAt: expiry(options.expirationDate) ?? undefined,
      occurredAt:
        options.timestamp !== undefined ? when(options.timestamp).toISOString() : undefined,
      infer: options.infer ?? true,
      procedural: options.memoryType === "procedural_memory",
      prompt: options.prompt,
      categories: options.categories,
      immutable: options.immutable,
      source: options.source
        ? {
            kind: options.source.objectId ? "file" : "conversation",
            ...(options.source.objectId ? { objectId: options.source.objectId } : {}),
            ...(options.source.label ? { label: options.source.label } : {}),
          }
        : { kind: "conversation" },
      wallet: options.wallet,
      wait: options.wait === "chain",
    });
    if (held.unsaved >= SNAPSHOT_EVERY) {
      await held.saveIndex({ wallet: options.wallet, wait: false }).catch((error) => {
        console.warn("[memdot] index snapshot skipped:", error);
      });
    }
    return {
      eventId: written.jobId,
      namespaceId: held.id,
      status: written.jobId ? "RUNNING" : "SUCCEEDED",
      results: written.entries.map((entry) => ({
        id: entry.id,
        memory: entry.text,
        event: "ADD",
      })),
      duplicates: written.duplicates,
      note: written.note,
    };
  }

  event(id: string): Promise<MemoryEvent> {
    return unwrap(
      this.ctx.transport.api.GET("/v1/memories/events/{id}", { params: { path: { id } } }),
    );
  }

  events(query: { limit?: number; cursor?: string } = {}) {
    return unwrap(this.ctx.transport.api.GET("/v1/memories/events", { params: { query } }));
  }

  /** Waits until a write is searchable or, if asked, finalized on chain. */
  async waitForEvent(id: string, until: "indexed" | "chain" = "indexed"): Promise<MemoryEvent> {
    const deadline = Date.now() + INDEX_TIMEOUT_MS;
    for (;;) {
      const event = await this.event(id);
      if (event.status === "FAILED") {
        throw new MemDotError(422, "MEMORY_FAILED", event.error ?? "The write failed.");
      }
      if (event.status === "SUCCEEDED" || (until === "indexed" && event.indexed)) return event;
      if (Date.now() > deadline) return event;
      await new Promise((resolve) => setTimeout(resolve, EVENT_POLL_MS));
    }
  }

  // ── Recall ──────────────────────────────────────────────────────────────────────────────────

  async search(query: string, options: SearchOptions = {}): Promise<ScoredMemory[]> {
    const held = await this.route(options.namespaceId);
    if (held) {
      const asOf = options.referenceDate !== undefined ? when(options.referenceDate) : undefined;
      const hits = await held.search({
        query,
        limit: options.topK ?? DEFAULT_TOP_K,
        threshold: options.threshold ?? DEFAULT_THRESHOLD,
        mode: options.mode ?? "hybrid",
        filter: parseFilters(options.filters),
        showExpired: options.showExpired ?? false,
        asOf,
        rerank: options.rerank ?? false,
      });
      return hits.map((hit) => ({
        ...fromEntry(hit, held.id),
        score: hit.score,
        scoreBreakdown: { semantic: hit.semantic, bm25: hit.bm25, entity: hit.entity },
        ...(hit.rerankScore !== undefined ? { rerankScore: hit.rerankScore } : {}),
      }));
    }
    const { results } = await unwrap(
      this.ctx.transport.api.POST("/v1/memories/search", {
        body: {
          query,
          top_k: options.topK ?? DEFAULT_TOP_K,
          threshold: options.threshold ?? DEFAULT_THRESHOLD,
          mode: options.mode ?? "hybrid",
          rerank: options.rerank ?? false,
          show_expired: options.showExpired ?? false,
          ...(options.namespaceId ? { namespace_id: options.namespaceId } : {}),
          ...(options.filters ? { filters: options.filters } : {}),
          ...(options.referenceDate !== undefined ? { reference_date: options.referenceDate } : {}),
        },
      }),
    );
    return results.map((raw: RawScored) => ({
      ...fromWire(raw),
      score: raw.score,
      scoreBreakdown: raw.score_breakdown,
      ...(raw.rerank_score !== undefined ? { rerankScore: raw.rerank_score } : {}),
    }));
  }

  async list(
    options: ListOptions = {},
  ): Promise<{ results: Memory[]; count: number; nextCursor: string | null }> {
    const pageSize = options.pageSize ?? DEFAULT_PAGE;
    const held = await this.route(options.namespaceId);
    if (held) {
      const entries = await held.list({
        filter: parseFilters(options.filters),
        showExpired: options.showExpired ?? false,
      });
      const start = options.cursor ? Number(options.cursor) : 0;
      const page = entries.slice(start, start + pageSize);
      const next = start + pageSize;
      return {
        results: page.map((entry) => fromEntry(entry, held.id)),
        count: entries.length,
        nextCursor: next < entries.length ? String(next) : null,
      };
    }
    const page = await unwrap(
      this.ctx.transport.api.POST("/v1/memories/list", {
        body: {
          page_size: pageSize,
          show_expired: options.showExpired ?? false,
          ...(options.namespaceId ? { namespace_id: options.namespaceId } : {}),
          ...(options.filters ? { filters: options.filters } : {}),
          ...(options.cursor ? { cursor: options.cursor } : {}),
        },
      }),
    );
    return {
      results: page.results.map(fromWire),
      count: page.count,
      nextCursor: page.next_cursor,
    };
  }

  /** The Private namespace that holds an id, known from an API refusal when none was given. */
  private async privateHolding(error: unknown): Promise<PrivateNamespace | null> {
    const details = (error as MemDotError).details as { namespaceId?: string } | undefined;
    if (
      !(error instanceof MemDotError) ||
      error.code !== "PRIVATE_NAMESPACE" ||
      !details?.namespaceId
    ) {
      return null;
    }
    return this.route(details.namespaceId);
  }

  async get(id: string): Promise<Memory> {
    try {
      return fromWire(
        await unwrap(this.ctx.transport.api.GET("/v1/memories/{id}", { params: { path: { id } } })),
      );
    } catch (error) {
      const held = await this.privateHolding(error);
      if (!held) throw error;
      const entry = await held.get(id);
      if (!entry) throw new MemDotError(404, "NOT_FOUND", "Memory not found.");
      return fromEntry(entry, held.id);
    }
  }

  /**
   * The Private namespace holding a memory, or null if it's Assisted. Asked before anything is sent:
   * text for a Private memory must never leave this device, not even to be refused.
   */
  private async holderOf(id: string): Promise<PrivateNamespace | null> {
    for (const held of this.privateNamespaces.values()) {
      if (held.holds(id)) return held;
    }
    try {
      await unwrap(this.ctx.transport.api.GET("/v1/memories/{id}", { params: { path: { id } } }));
      return null;
    } catch (error) {
      const held = await this.privateHolding(error);
      if (!held) throw error;
      return held;
    }
  }

  async update(
    id: string,
    change: MemoryUpdate,
    options: { wallet?: Wallet; wait?: boolean } = {},
  ): Promise<Memory> {
    const held = await this.holderOf(id);
    if (held) {
      const next = await held.update(
        id,
        {
          text: change.text,
          metadata: change.metadata,
          expiresAt: expiry(change.expirationDate),
        },
        { wallet: options.wallet, wait: options.wait ?? false },
      );
      return fromEntry(next, held.id);
    }
    return fromWire(
      await unwrap(
        this.ctx.transport.api.PUT("/v1/memories/{id}", {
          params: { path: { id } },
          body: {
            ...(change.text !== undefined ? { text: change.text } : {}),
            ...(change.metadata ? { metadata: change.metadata } : {}),
            ...(change.expirationDate !== undefined
              ? { expiration_date: change.expirationDate }
              : {}),
          },
        }),
      ),
    );
  }

  /** Forgets one memory: out of search and lists at once, in both modes. */
  async delete(id: string): Promise<void> {
    await unwrap(this.ctx.transport.api.DELETE("/v1/memories/{id}", { params: { path: { id } } }));
    for (const held of this.privateNamespaces.values()) held.forget([id]);
  }

  /** Forgets everything in a scope. `"*"` matches every value of one. */
  async deleteAll(scope: MemoryScope & { namespaceId?: string }): Promise<{ deleted: number }> {
    if (!scope.userId && !scope.agentId && !scope.runId) {
      throw new MemDotError(
        400,
        "SCOPE_REQUIRED",
        "Give at least one of userId, agentId or runId.",
      );
    }
    const held = await this.route(scope.namespaceId);
    if (held) {
      const entries = await held.list({
        filter: parseFilters({
          ...(scope.userId ? { user_id: scope.userId } : {}),
          ...(scope.agentId ? { agent_id: scope.agentId } : {}),
          ...(scope.runId ? { run_id: scope.runId } : {}),
        }),
        showExpired: true,
      });
      await this.batchDelete(entries.map((entry) => entry.id));
      return { deleted: entries.length };
    }
    const { deleted } = await unwrap(
      this.ctx.transport.api.DELETE("/v1/memories", {
        params: {
          query: {
            ...(scope.namespaceId ? { namespace_id: scope.namespaceId } : {}),
            ...(scope.userId ? { user_id: scope.userId } : {}),
            ...(scope.agentId ? { agent_id: scope.agentId } : {}),
            ...(scope.runId ? { run_id: scope.runId } : {}),
          },
        },
      }),
    );
    return { deleted };
  }

  async history(id: string): Promise<HistoryEvent[]> {
    try {
      const { results } = await unwrap(
        this.ctx.transport.api.GET("/v1/memories/{id}/history", { params: { path: { id } } }),
      );
      return results.map((row) => ({
        event: row.event,
        oldMemory: row.old_memory,
        newMemory: row.new_memory,
        actor: row.actor,
        createdAt: row.created_at,
      }));
    } catch (error) {
      const held = await this.privateHolding(error);
      if (!held) throw error;
      const entry = await held.get(id);
      return (entry?.history ?? []).map((change) => ({
        event: change.event,
        oldMemory: change.previous,
        newMemory: change.text,
        actor: change.actor ?? null,
        createdAt: change.at,
      }));
    }
  }

  async batchUpdate(
    memories: { id: string; text?: string; metadata?: Record<string, unknown> }[],
    options: { wallet?: Wallet } = {},
  ): Promise<void> {
    const assisted: typeof memories = [];
    for (const memory of memories) {
      const held = await this.holderOf(memory.id);
      if (!held) assisted.push(memory);
      else {
        await held.update(
          memory.id,
          { text: memory.text, metadata: memory.metadata },
          { wallet: options.wallet, wait: false },
        );
      }
    }
    if (assisted.length === 0) return;
    await unwrap(
      this.ctx.transport.api.PUT("/v1/batch", {
        body: {
          memories: assisted.map(({ id, text, metadata }) => ({
            memory_id: id,
            ...(text !== undefined ? { text } : {}),
            ...(metadata ? { metadata } : {}),
          })),
        },
      }),
    );
  }

  async batchDelete(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await unwrap(
      this.ctx.transport.api.DELETE("/v1/batch", {
        body: { memories: ids.map((id) => ({ memory_id: id })) },
      }),
    );
    for (const held of this.privateNamespaces.values()) held.forget(ids);
  }

  async feedback(
    id: string,
    feedback: "POSITIVE" | "NEGATIVE" | "VERY_NEGATIVE" | null,
    reason?: string,
  ) {
    return unwrap(
      this.ctx.transport.api.POST("/v1/feedback", {
        body: {
          memory_id: id,
          feedback,
          ...(reason ? { feedback_reason: reason } : {}),
        },
      }),
    );
  }

  async summary(options: { namespaceId?: string; filters?: Record<string, unknown> } = {}) {
    const held = await this.route(options.namespaceId);
    if (held) {
      return { summary: await held.summary({ filter: parseFilters(options.filters) }) };
    }
    return unwrap(
      this.ctx.transport.api.POST("/v1/memories/summary", {
        body: {
          ...(options.namespaceId ? { namespace_id: options.namespaceId } : {}),
          ...(options.filters ? { filters: options.filters } : {}),
        },
      }),
    );
  }

  // ── Entities ────────────────────────────────────────────────────────────────────────────────

  async entities(options: { namespaceId?: string } = {}): Promise<Entity[]> {
    const held = await this.route(options.namespaceId);
    if (held) {
      const entries = await held.list({ showExpired: true });
      const totals = new Map<string, Entity>();
      const count = (type: Entity["type"], id: string | undefined, entry: MemoryEntry) => {
        if (!id) return;
        const key = `${type}:${id}`;
        const entity = totals.get(key);
        if (!entity) {
          totals.set(key, {
            id,
            type,
            totalMemories: 1,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
            namespaceId: held.id,
          });
          return;
        }
        entity.totalMemories += 1;
        if (entry.createdAt < entity.createdAt) entity.createdAt = entry.createdAt;
        if (entry.updatedAt > entity.updatedAt) entity.updatedAt = entry.updatedAt;
      };
      for (const entry of entries) {
        count("user", entry.userId, entry);
        count("agent", entry.agentId, entry);
        count("run", entry.runId, entry);
      }
      return [...totals.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    const { results } = await unwrap(
      this.ctx.transport.api.GET("/v1/entities", {
        params: { query: options.namespaceId ? { namespace_id: options.namespaceId } : {} },
      }),
    );
    return results.map((row) => ({
      id: row.id,
      type: row.type,
      totalMemories: row.total_memories,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      namespaceId: row.namespace_id,
    }));
  }

  /** Forgets a user, agent or run, and every memory it holds. */
  async deleteEntity(
    type: Entity["type"],
    id: string,
    options: { namespaceId?: string } = {},
  ): Promise<{ deleted: number }> {
    const held = await this.route(options.namespaceId);
    if (held) {
      const key = { user: "userId", agent: "agentId", run: "runId" }[type];
      return this.deleteAll({ namespaceId: held.id, [key]: id });
    }
    const { deleted } = await unwrap(
      this.ctx.transport.api.DELETE("/v1/entities/{type}/{id}", {
        params: {
          path: { type, id },
          query: options.namespaceId ? { namespace_id: options.namespaceId } : {},
        },
      }),
    );
    return { deleted };
  }

  // ── Keeping a namespace healthy ─────────────────────────────────────────────────────────────

  /**
   * Rebuilds the index from the chain alone. Assisted: the server re-reads every segment. Private:
   * this device does, over its own connection to V3, and throws away what it held first.
   */
  async restore(namespaceId: string) {
    const held = await this.route(namespaceId);
    if (held) return held.restore();
    const accepted = await unwrap(
      this.ctx.transport.api.POST("/v1/namespaces/{id}/restore", {
        params: { path: { id: namespaceId } },
      }),
    );
    return this.waitForEvent(accepted.event_id, "chain");
  }

  /** Forgets everything in a namespace. */
  async reset(namespaceId: string): Promise<void> {
    await unwrap(
      this.ctx.transport.api.POST("/v1/namespaces/{id}/reset", {
        params: { path: { id: namespaceId } },
      }),
    );
    this.privateNamespaces.delete(namespaceId);
  }

  /** Merges mostly dead segments. Automatic for Assisted; Private runs it here, when asked. */
  async compact(namespaceId: string, options: { wallet?: Wallet } = {}) {
    const held = await this.route(namespaceId);
    if (held) return held.compact(options);
    return unwrap(
      this.ctx.transport.api.POST("/v1/namespaces/{id}/compact", {
        params: { path: { id: namespaceId } },
      }),
    );
  }

  /** Private: stores the index, encrypted, on V3, so another device can start without embedding. */
  async saveIndex(namespaceId: string, options: { wallet?: Wallet } = {}): Promise<string> {
    const held = await this.route(namespaceId);
    if (!held)
      throw new MemDotError(400, "NOT_PRIVATE", "Only Private namespaces keep a snapshot.");
    return held.saveIndex({ ...options, wait: true });
  }

  // ── Import and export ───────────────────────────────────────────────────────────────────────

  /** Every memory in a namespace with what's needed to import it elsewhere. */
  async exportMemories(namespaceId: string): Promise<Record<string, unknown>[]> {
    const held = await this.route(namespaceId);
    if (held) {
      const entries = await held.list({ showExpired: true });
      return entries.map((entry) => ({
        id: entry.id,
        memory: entry.text,
        user_id: entry.userId ?? null,
        agent_id: entry.agentId ?? null,
        run_id: entry.runId ?? null,
        metadata: entry.metadata ?? null,
        categories: entry.categories ?? null,
        expiration_date: entry.expiresAt ?? null,
        created_at: entry.createdAt,
        updated_at: entry.updatedAt,
      }));
    }
    const { memories } = await unwrap(
      this.ctx.transport.api.GET("/v1/namespaces/{id}/export", {
        params: { path: { id: namespaceId } },
      }),
    );
    return memories;
  }

  /**
   * Imports an export file: MemDot's own, or a list or `{results: […]}` from another memory
   * product. Stored as written, no model involved; the same fact in the same scope is dropped.
   */
  async importMemories(
    data: unknown,
    options: {
      namespaceId: string;
      source?: string;
      /** For rows that name no user, agent or run. */
      userId?: string;
      wallet?: Wallet;
    },
  ): Promise<{ imported: number; duplicates: number; skipped: number }> {
    const held = await this.route(options.namespaceId);
    const { items, skipped } = parseMemoryImport(data);
    if (held) {
      let imported = 0;
      let duplicates = 0;
      const unscoped = items.filter((item) => !item.userId && !item.agentId && !item.runId);
      if (unscoped.length > 0 && !options.userId) {
        throw new MemDotError(
          409,
          "SCOPE_REQUIRED",
          `${unscoped.length} of these memories name no user, agent or run. Pass userId to file them under one.`,
        );
      }
      const written = await held.importItems(
        items.map((item) =>
          item.userId || item.agentId || item.runId
            ? item
            : { ...item, userId: options.userId as string },
        ),
        options.source ?? "import",
        options.wallet,
      );
      imported += written.imported;
      duplicates += written.duplicates;
      return { imported, duplicates, skipped };
    }
    const accepted = await unwrap(
      this.ctx.transport.api.POST("/v1/memories/import", {
        body: {
          namespace_id: options.namespaceId,
          data,
          source: options.source ?? "import",
          ...(options.userId ? { user_id: options.userId } : {}),
        },
      }),
    );
    const event = await this.waitForEvent(accepted.event_id, "indexed");
    return {
      imported: event.results.length,
      duplicates: event.duplicates,
      skipped: accepted.skipped,
    };
  }

  /**
   * Adds memory segments to the public registry, grouped per space into one record each: what the
   * server wrote, which only this device can sign for, and what this device wrote earlier.
   */
  async recordServerSegments(): Promise<void> {
    if (!this.ctx.vault.unlocked) return;
    const { results } = await unwrap(
      this.ctx.transport.api.GET("/v1/namespaces/unrecorded-segments"),
    );
    if (results.length === 0) return;
    const bySpace = new Map<string, typeof results>();
    for (const segment of results) {
      bySpace.set(segment.space_id, [...(bySpace.get(segment.space_id) ?? []), segment]);
    }
    for (const [spaceId, segments] of bySpace) {
      await this.ctx.registry.addObjects(
        spaceId,
        segments.map((segment) => ({
          kind: "segment",
          rootCid: segment.cid,
          size: segment.size,
        })),
      );
    }
    await unwrap(
      this.ctx.transport.api.POST("/v1/namespaces/recorded-segments", {
        body: { ids: results.map((segment) => segment.id) },
      }),
    );
  }
}
