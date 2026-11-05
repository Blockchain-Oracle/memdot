import { AgentMemory, type MemDot } from "@memdot/sdk";
import type { ChatHistory, ChatMemory, Message } from "@n8n/ai-node-sdk";

/** Marks a memory as a stored turn, so it isn't mistaken for a fact. */
export const TURN_KIND = "n8n_chat_turn";
/** A long answer would use up a space's quota in a few turns, and the window only needs the gist. */
const MAX_MESSAGE_CHARS = 4000;
const LABEL_CHARS = 120;
/** In a filter this means every session there is, so it can't name one. */
const WILDCARD = "*";

type StoredRole = "user" | "assistant";
const STORED_ROLES = new Set<string>(["user", "assistant"]);

interface StoredMessage {
  role: string;
  text: string;
}

const textOf = (message: Message): string =>
  message.content
    .flatMap((part) => ("text" in part && part.type === "text" ? [part.text] : []))
    .join("\n");

const toMessage = (role: StoredRole, text: string): Message => ({
  role,
  content: [{ type: "text", text }],
});

/**
 * One conversation's turns, stored under its session. They carry no user id, so a search for what's
 * known about a person never finds transcripts.
 */
export class MemDotChatHistory implements ChatHistory {
  constructor(
    private readonly memdot: MemDot,
    private readonly sessionId: string,
    private readonly namespaceId: string | undefined,
    private readonly windowSize: number,
  ) {
    if (sessionId === WILDCARD) {
      throw new Error(`"${WILDCARD}" means every session, so it can't name one.`);
    }
  }

  private get where() {
    return this.namespaceId ? { namespaceId: this.namespaceId } : {};
  }

  async getMessages(): Promise<Message[]> {
    const { results } = await this.memdot.memories.list({
      ...this.where,
      pageSize: this.windowSize,
      filters: { AND: [{ run_id: { eq: this.sessionId } }, { "metadata.kind": TURN_KIND }] },
    });
    return (
      results
        .slice()
        .reverse()
        .flatMap((memory) => (memory.metadata?.messages as StoredMessage[] | undefined) ?? [])
        // Only what a conversation holds. A stored "system" message could give the model orders.
        .filter((stored) => STORED_ROLES.has(stored.role))
        .map((stored) => toMessage(stored.role as StoredRole, stored.text))
    );
  }

  async addMessage(message: Message): Promise<void> {
    await this.addMessages([message]);
  }

  /** One memory per turn: every memory is a write, and a turn is read back whole. */
  async addMessages(messages: Message[]): Promise<void> {
    const stored = messages.map((message) => ({
      role: message.role,
      text: textOf(message).slice(0, MAX_MESSAGE_CHARS),
    }));
    const first = stored[0]?.text;
    if (!first) return;
    // The time makes each one its own: the same words twice in a session are still two turns, and
    // identical text under one scope would count as a duplicate and be dropped.
    await this.memdot.memories.add(`${new Date().toISOString()} ${first.slice(0, LABEL_CHARS)}`, {
      ...this.where,
      runId: this.sessionId,
      infer: false,
      metadata: { kind: TURN_KIND, messages: stored },
    });
  }

  async clear(): Promise<void> {
    await this.memdot.memories.deleteAll({ ...this.where, runId: this.sessionId });
  }
}

export interface MemDotChatMemoryOptions {
  sessionId: string;
  /** Who the facts are about. Without one, only this session's turns are kept. */
  userId?: string;
  /** What to look for among those facts: usually what was just asked. */
  query?: string;
  namespaceId?: string;
  windowSize: number;
  warn: (message: string) => void;
}

/**
 * The AI Agent's memory slot. The last turns of this session keep the conversation going, and what's
 * known about the person comes along from every earlier one. MemDot being down costs the agent its
 * memory for this message, not the answer.
 */
export class MemDotChatMemory implements ChatMemory {
  readonly chatHistory: MemDotChatHistory;
  private readonly facts: AgentMemory | null;

  constructor(
    memdot: MemDot,
    private readonly options: MemDotChatMemoryOptions,
  ) {
    const { sessionId, userId, namespaceId, windowSize, warn } = options;
    this.chatHistory = new MemDotChatHistory(memdot, sessionId, namespaceId, windowSize);
    this.facts = userId
      ? new AgentMemory(memdot, {
          userId,
          ...(namespaceId ? { namespaceId } : {}),
          onError: (error, during) => warn(`MemDot ${during} skipped: ${(error as Error).message}`),
        })
      : null;
  }

  async loadMessages(): Promise<Message[]> {
    const [turns, recalled] = await Promise.all([
      this.chatHistory.getMessages().catch((error: Error) => {
        this.options.warn(`MemDot couldn't load this session's turns: ${error.message}`);
        return [] as Message[];
      }),
      this.options.query && this.facts ? this.facts.recall(this.options.query) : null,
    ]);
    // As a person's message, since several models refuse a system message after the first. It says
    // itself that these are notes rather than orders, and nothing here answers on the model's behalf.
    return recalled ? [toMessage("user", recalled), ...turns] : turns;
  }

  async saveTurn(input: string, output: string): Promise<void> {
    await this.chatHistory
      .addMessages([toMessage("user", input), toMessage("assistant", output)])
      .catch((error: Error) =>
        this.options.warn(`MemDot couldn't save this turn: ${error.message}`),
      );
    await this.facts?.saveExchange(input, output);
  }

  async clear(): Promise<void> {
    await this.chatHistory.clear();
  }
}
