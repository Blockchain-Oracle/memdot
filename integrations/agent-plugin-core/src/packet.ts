import { createHash } from "node:crypto";
import {
  CHECKPOINT_CHARS,
  MAX_CHANGED_PATHS,
  MAX_FAILED_COMMANDS,
  MAX_MESSAGE_CHARS,
  MAX_NOTE_CHARS,
  MAX_PACKET_CHARS,
  MIN_PACKET_CHARS,
} from "./constants.js";
import { repoPath } from "./repo.js";
import type { ReadEvent, SessionEvent, SessionState } from "./store.js";

const PACKET_ID_CHARS = 32;
const PREVIEW_CHARS = 500;

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface Packet {
  id: string;
  createdAt: string;
  host: string;
  repoId: string;
  repoName: string;
  userId: string;
  sessionId: string;
  metadata: Record<string, string>;
  messages: ChatMessage[];
  /** For a namespace with no model: stored as written. */
  note: string;
  attempts: number;
  notBefore: number;
  lastError: string | null;
}

const textOf = (event: SessionEvent): string => {
  if (event.kind === "prompt" || event.kind === "assistant") return event.text;
  if (event.kind === "stop") return event.text ?? "";
  return "";
};

/**
 * How many events the next checkpoint takes: everything when forced; otherwise the shortest run of
 * whole turns that has reached the limit, so an exchange is never split.
 */
export function selectCheckpoint(
  events: ReadEvent[],
  { force, exchanges }: { force: boolean; exchanges: number },
): number {
  if (force) return events.length;
  let turns = 0;
  let chars = 0;
  for (const [index, { event }] of events.entries()) {
    chars += textOf(event).length;
    if (event.kind !== "stop") continue;
    turns += 1;
    if (turns >= exchanges || chars >= CHECKPOINT_CHARS) return index + 1;
  }
  return 0;
}

/** Long text keeps its start and its end: that's where the point of a message tends to be. */
function trimMessage(text: string): string {
  if (text.length <= MAX_MESSAGE_CHARS) return text;
  const half = Math.floor(MAX_MESSAGE_CHARS / 2);
  return `${text.slice(0, half)}\n...[${text.length - MAX_MESSAGE_CHARS} characters left out]...\n${text.slice(-half)}`;
}

function evidenceOf(events: SessionEvent[], root: string): string {
  const changed = new Set<string>();
  const failures: string[] = [];
  for (const event of events) {
    if (event.kind !== "tool" || event.subagent) continue;
    if (event.path && event.changedChars !== undefined) {
      const path = repoPath(root, event.path);
      if (path) changed.add(path);
    }
    if (event.failed && event.command) {
      const detail = (event.error ?? event.preview ?? "")
        .replace(/\s+/g, " ")
        .slice(0, PREVIEW_CHARS);
      failures.push(`- ${event.command.replace(/\s+/g, " ")}${detail ? ` -> ${detail}` : ""}`);
    }
  }
  const parts: string[] = [];
  if (changed.size) {
    parts.push(
      `Changed paths:\n${[...changed]
        .slice(0, MAX_CHANGED_PATHS)
        .map((p) => `- ${p}`)
        .join("\n")}`,
    );
  }
  if (failures.length) {
    parts.push(`Commands that failed:\n${failures.slice(-MAX_FAILED_COMMANDS).join("\n")}`);
  }
  return parts.length ? `Additional details from this session\n${parts.join("\n")}` : "";
}

/** The conversation, with what happened in the repository added to the last answer. */
export function messagesOf(events: SessionEvent[], root: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const event of events) {
    if (event.kind === "prompt" && event.text) {
      messages.push({ role: "user", content: trimMessage(event.text) });
    } else if ((event.kind === "assistant" || event.kind === "stop") && textOf(event)) {
      const content = trimMessage(textOf(event));
      // A host that reports the answer and the turn's end apart can report the same text twice.
      if (messages.at(-1)?.content !== content) messages.push({ role: "assistant", content });
    }
  }
  // Over the limit, the oldest goes first: what the session ended on matters most.
  let total = messages.reduce((sum, message) => sum + message.content.length, 0);
  while (total > MAX_PACKET_CHARS && messages.length > 1) {
    total -= (messages.shift() as ChatMessage).content.length;
  }
  const evidence = evidenceOf(events, root);
  if (evidence && messages.length) {
    const last = messages.at(-1) as ChatMessage;
    if (last.role === "assistant") last.content = `${last.content}\n\n${evidence}`;
    else messages.push({ role: "assistant", content: evidence });
  }
  return messages;
}

/** Without a model nothing can be extracted, so a short note of the session is kept instead. */
export function noteOf(messages: ChatMessage[], repoName: string): string {
  const asked = messages.find((message) => message.role === "user")?.content ?? "";
  const ended = messages.findLast((message) => message.role === "assistant")?.content ?? "";
  const room = Math.floor(MAX_NOTE_CHARS / 2);
  return [
    `Session in ${repoName}.`,
    `Asked: ${asked.slice(0, room)}`,
    `Ended with: ${ended.slice(0, room)}`,
  ]
    .join("\n")
    .trim();
}

/** A packet for these events, or nothing when they hold too little to be worth saving. */
export function buildPacket(
  taken: ReadEvent[],
  state: SessionState,
  userId: string,
): Packet | null {
  const events = taken.map((entry) => entry.event);
  const messages = messagesOf(events, state.repo.root);
  const chars = messages.reduce((sum, message) => sum + message.content.length, 0);
  if (chars < MIN_PACKET_CHARS) return null;
  const first = taken[0]?.end ?? 0;
  const last = taken.at(-1)?.end ?? 0;
  return {
    id: createHash("sha256")
      .update(`${state.repo.id}\0${state.sessionId}\0${first}\0${last}`)
      .digest("hex")
      .slice(0, PACKET_ID_CHARS),
    createdAt: new Date().toISOString(),
    host: state.host,
    repoId: state.repo.id,
    repoName: state.repo.name,
    userId,
    sessionId: state.sessionId,
    metadata: {
      source: `${state.host}_plugin`,
      repo: state.repo.name,
      ...(state.repo.branch ? { branch: state.repo.branch } : {}),
      ...(state.repo.sha ? { git_sha: state.repo.sha } : {}),
    },
    messages,
    note: noteOf(messages, state.repo.name),
    attempts: 0,
    notBefore: 0,
    lastError: null,
  };
}
