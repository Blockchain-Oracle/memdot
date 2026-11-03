import { type ChatMessage, RECALL_PREAMBLE } from "@memdot/memory-engine";
import { MemDotError } from "./errors.js";
import type { MemDot } from "./memdot.js";
import type { AddResult, MemoryScope, ScoredMemory } from "./memories.js";

/** Below this a prompt has nothing to search for: "ok", "thanks". */
const RECALL_MIN_CHARS = 3;
/** Below this an exchange has nothing to keep, and asking a model to look costs a call. */
const SAVE_MIN_CHARS = 20;
const DEFAULT_RECALL_TOP_K = 5;
/** Generous, but one bad memory can't crowd out the conversation. */
const RECALL_MAX_CHARS = 8000;
/** A model loop asks several times per turn, with the same last message. */
const RECALL_REUSE_MS = 60_000;
const RECALL_REUSE_ENTRIES = 32;

/** Whose memory this is. Give at least one of the ids; `namespaceId` picks where it lives. */
export interface MemoryBinding extends MemoryScope {
  namespaceId?: string;
}

export interface AgentMemoryOptions extends MemoryBinding {
  /** Search before the model answers. Off: only the tools or your own code read memory. */
  recall?: boolean;
  /** How many memories to bring along (default 5). */
  topK?: number;
  /** Minimum similarity to bring one along, 0 to 1. */
  threshold?: number;
  /** Keep what each exchange taught, distilled by a model (default). Off: nothing is saved. */
  save?: boolean;
  /**
   * Hands a save over instead of holding the reply for it: Next's `after`, a worker's `waitUntil`.
   * Without it the save finishes before the call returns.
   */
  waitUntil?: (work: Promise<unknown>) => void;
  /** Memory failing never fails the model call. This hears about it (default: console.warn). */
  onError?: (error: unknown, during: "recall" | "save") => void;
}

/** `{ AND: [{ user_id }, …] }`, or nothing when no id is given. */
export function scopeFilter(scope: MemoryScope): Record<string, unknown> | undefined {
  const parts = [
    ...(scope.userId ? [{ user_id: scope.userId }] : []),
    ...(scope.agentId ? [{ agent_id: scope.agentId }] : []),
    ...(scope.runId ? [{ run_id: scope.runId }] : []),
  ];
  return parts.length ? { AND: parts } : undefined;
}

/** One line of plain text that can't close a wrapper or start a section of its own. */
const memoryLine = (text: string) =>
  text.replace(/\s+/g, " ").replaceAll("<", "&lt;").replaceAll(">", "&gt;").trim();

/**
 * Memories as text for a system prompt, framed as notes rather than instructions: a memory can hold
 * whatever someone once said. Later ones drop rather than get cut. Null when there are none.
 */
export function recallContext(
  memories: Pick<ScoredMemory, "memory">[],
  limit = RECALL_MAX_CHARS,
): string | null {
  const lines: string[] = [];
  let used = RECALL_PREAMBLE.length;
  for (const { memory } of memories) {
    const line = `- ${memoryLine(memory)}`;
    if (line === "- ") continue;
    if (used + line.length + 1 > limit) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.length ? `${RECALL_PREAMBLE}\n\n${lines.join("\n")}` : null;
}

/** Adds to the system prompt of a chat: most providers want it whole, at the start. */
export function withRecall(system: string | null | undefined, recalled: string | null): string {
  return [system, recalled].filter(Boolean).join("\n\n");
}

/**
 * A client and whose memory it's working on: what framework adapters share, so recall reads the same
 * and a failed save behaves the same in every one of them.
 */
export class AgentMemory {
  private client: Promise<MemDot> | null = null;
  private readonly recent = new Map<string, { at: number; text: Promise<string | null> }>();

  constructor(
    private readonly connect: MemDot | (() => Promise<MemDot>),
    readonly options: AgentMemoryOptions,
  ) {
    if (!options.userId && !options.agentId && !options.runId) {
      throw new MemDotError(
        400,
        "SCOPE_REQUIRED",
        "Give at least one of userId, agentId or runId, so memories have someone to belong to.",
      );
    }
  }

  private get memdot(): Promise<MemDot> {
    this.client ??=
      typeof this.connect === "function" ? this.connect() : Promise.resolve(this.connect);
    return this.client;
  }

  private get scope(): MemoryScope {
    const { userId, agentId, runId } = this.options;
    return {
      ...(userId ? { userId } : {}),
      ...(agentId ? { agentId } : {}),
      ...(runId ? { runId } : {}),
    };
  }

  private get where(): { namespaceId?: string } {
    return this.options.namespaceId ? { namespaceId: this.options.namespaceId } : {};
  }

  private report(error: unknown, during: "recall" | "save"): void {
    if (this.options.onError) this.options.onError(error, during);
    else console.warn(`[memdot] ${during} skipped:`, (error as Error).message ?? error);
  }

  /** Finds memories. This throws: a tool should see why it came back empty. */
  async search(query: string, options: { topK?: number } = {}): Promise<ScoredMemory[]> {
    const filters = scopeFilter(this.scope);
    return (await this.memdot).memories.search(query, {
      ...this.where,
      topK: options.topK ?? this.options.topK ?? DEFAULT_RECALL_TOP_K,
      ...(this.options.threshold !== undefined ? { threshold: this.options.threshold } : {}),
      ...(filters ? { filters } : {}),
    });
  }

  /** Keeps a fact as written: whoever chose it already did the distilling. This throws too. */
  async remember(text: string, metadata?: Record<string, unknown>): Promise<AddResult> {
    return (await this.memdot).memories.add(text, {
      ...this.scope,
      ...this.where,
      infer: false,
      ...(metadata ? { metadata } : {}),
    });
  }

  /** What to tell the model about this prompt, or null. Never throws. */
  recall(query: string): Promise<string | null> {
    if (this.options.recall === false || query.trim().length < RECALL_MIN_CHARS) {
      return Promise.resolve(null);
    }
    const now = Date.now();
    const known = this.recent.get(query);
    if (known && now - known.at < RECALL_REUSE_MS) return known.text;
    const text = this.search(query)
      .then((memories) => recallContext(memories))
      .catch((error) => {
        this.recent.delete(query);
        this.report(error, "recall");
        return null;
      });
    this.recent.set(query, { at: now, text });
    if (this.recent.size > RECALL_REUSE_ENTRIES) {
      this.recent.delete(this.recent.keys().next().value as string);
    }
    return text;
  }

  private async saveNow(messages: ChatMessage[], plain: string): Promise<void> {
    const memdot = await this.memdot;
    const base = { ...this.scope, ...this.where, wait: false as const };
    try {
      await memdot.memories.add(messages, base);
    } catch (error) {
      // A Private namespace with no model of its own: keep what was said rather than nothing.
      if (!(error instanceof MemDotError) || error.code !== "MODEL_REQUIRED") throw error;
      await memdot.memories.add(plain, { ...base, infer: false });
    }
  }

  /** Keeps what this exchange taught. Never throws; runs under `waitUntil` if there is one. */
  async saveExchange(user: string, assistant: string): Promise<void> {
    if (this.options.save === false) return;
    if (`${user}${assistant}`.trim().length < SAVE_MIN_CHARS) return;
    const messages: ChatMessage[] = [
      { role: "user", content: user },
      ...(assistant ? [{ role: "assistant" as const, content: assistant }] : []),
    ];
    const work = this.saveNow(messages, user).catch((error) => this.report(error, "save"));
    if (this.options.waitUntil) this.options.waitUntil(work);
    else await work;
  }
}
