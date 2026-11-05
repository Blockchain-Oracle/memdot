import { AgentMemory, type MemDot } from "@memdot/sdk";
import type { ChatHistory, ChatMemory, Message } from "@n8n/ai-node-sdk";

/** Marks a memory as a stored turn, so it isn't mistaken for a fact. */
const TURN_KIND = "n8n_chat_turn";
/** A long answer would use up a space's quota in a few turns, and the window only needs the gist. */
const MAX_MESSAGE_CHARS = 4000;
const LABEL_CHARS = 120;

interface StoredMessage {
  role: Message["role"];
  text: string;
}

const textOf = (message: Message): string =>
  message.content
    .flatMap((part) => ("text" in part && part.type === "text" ? [part.text] : []))
    .join("\n");

const toMessage = ({ role, text }: StoredMessage): Message => ({
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
  ) {}

  private get where() {
    return this.namespaceId ? { namespaceId: this.namespaceId } : {};
  }

  async getMessages(): Promise<Message[]> {
    const { results } = await this.memdot.memories.list({
      ...this.where,
      pageSize: this.windowSize,
      filters: { AND: [{ run_id: this.sessionId }, { "metadata.kind": TURN_KIND }] },
    });
    return results
      .slice()
      .reverse()
      .flatMap((memory) => (memory.metadata?.messages as StoredMessage[] | undefined) ?? [])
      .map(toMessage);
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
    await this.memdot.memories.add(first.slice(0, LABEL_CHARS), {
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
 * known about the person comes along from every earlier one.
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
      this.chatHistory.getMessages(),
      this.options.query && this.facts ? this.facts.recall(this.options.query) : null,
    ]);
    if (!recalled) return turns;
    // Several models refuse a system message after the first, and this one lands in the middle.
    return [
      toMessage({ role: "user", text: recalled }),
      // A plain "ok" here leaves weaker models saying they know nothing about the person.
      toMessage({
        role: "assistant",
        text: "Thanks. I'll answer from these notes where they help.",
      }),
      ...turns,
    ];
  }

  async saveTurn(input: string, output: string): Promise<void> {
    await this.chatHistory.addMessages([
      toMessage({ role: "user", text: input }),
      toMessage({ role: "assistant", text: output }),
    ]);
    await this.facts?.saveExchange(input, output);
  }

  async clear(): Promise<void> {
    await this.chatHistory.clear();
  }
}
