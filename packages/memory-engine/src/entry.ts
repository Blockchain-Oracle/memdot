import { blake2b } from "@noble/hashes/blake2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { MemoryRelation } from "./graph.js";

/** Why a memory exists. Deleting a file deletes the memories derived from it (R8). */
export interface MemorySource {
  kind: "conversation" | "file" | "manual" | "import";
  /** The file it was read from. */
  objectId?: string | undefined;
  /** Who wrote it: a client name such as "claude-code", or the imported product. */
  label?: string | undefined;
}

export type MemoryEvent = "ADD" | "UPDATE" | "DELETE";

/** One past state of a memory. A forgotten memory keeps the events and drops the text. */
export interface MemoryChange {
  event: MemoryEvent;
  text: string | null;
  previous: string | null;
  at: string;
  actor?: string | undefined;
}

/**
 * A memory as stored on Portaldot V3: one entry of an encrypted segment. It holds everything
 * needed to rebuild the index from the chain, so a lost database or index costs nothing.
 */
export interface MemoryEntry {
  v: 1;
  id: string;
  /** Bumped by each update; the highest version found in a namespace's segments wins. */
  version: number;
  text: string;
  userId?: string | undefined;
  agentId?: string | undefined;
  runId?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  categories?: string[] | undefined;
  /** Names of people, places and things the text mentions; they lift matching searches. */
  entities?: string[] | undefined;
  /** How those names connect, in the memory's own words. Graph memory is built from these. */
  relations?: MemoryRelation[] | undefined;
  memoryType?: "fact" | "procedural" | undefined;
  /** Whose statement this is: the user, or the assistant in the conversation. */
  attributedTo?: "user" | "assistant" | undefined;
  source?: MemorySource | undefined;
  /** Extraction failed, so this is the raw text instead of distilled facts. */
  raw?: boolean | undefined;
  /** Refuses updates. */
  immutable?: boolean | undefined;
  createdAt: string;
  updatedAt: string;
  /** When the fact happened, if the caller said. */
  occurredAt?: string | undefined;
  expiresAt?: string | undefined;
  history?: MemoryChange[] | undefined;
}

export const encodeEntry = (entry: MemoryEntry): Uint8Array => utf8ToBytes(JSON.stringify(entry));

export function decodeEntry(bytes: Uint8Array): MemoryEntry {
  const entry = JSON.parse(new TextDecoder().decode(bytes)) as Partial<MemoryEntry>;
  if (
    entry.v !== 1 ||
    typeof entry.id !== "string" ||
    typeof entry.text !== "string" ||
    typeof entry.version !== "number" ||
    typeof entry.createdAt !== "string" ||
    typeof entry.updatedAt !== "string"
  ) {
    throw new Error("not a MemDot memory entry");
  }
  return entry as MemoryEntry;
}

/** A memory's text reduced so that trivial differences (case, spacing) count as the same fact. */
export function normalizeText(text: string): string {
  return text.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/** Same scope, same fact: the second add is dropped. Hashed, so it names no content. */
export function dedupeKey(
  text: string,
  scope: { userId?: string | null; agentId?: string | null; runId?: string | null },
): string {
  const material = [
    scope.userId ?? "",
    scope.agentId ?? "",
    scope.runId ?? "",
    normalizeText(text),
  ];
  return bytesToHex(blake2b(utf8ToBytes(material.join("\u0000")), { dkLen: 16 }));
}
