import type { UIMessage } from "ai";

export interface RecalledMemory {
  id: string;
  memory: string;
  score: number;
}

/** Sent along with each reply, so the page can show what the answer drew on. */
export interface ReplyMetadata {
  recalled?: RecalledMemory[];
}

export type ChatMessage = UIMessage<ReplyMetadata>;
