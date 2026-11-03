import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LOCK_HEARTBEAT_MS, STALE_LOCK_MS } from "./constants.js";
import { DIR_MODE, ensureDir, FILE_MODE, paths, writePrivate } from "./paths.js";
import { identifyRepo, type RepoIdentity } from "./repo.js";

const SESSION_ID_CHARS = 24;
const LOCK_WAIT_MS = 100;

export type SessionEvent =
  | { kind: "prompt"; at: string; text: string }
  /** A final answer, on hosts that report it apart from the turn ending. */
  | { kind: "assistant"; at: string; text: string }
  /** A turn finished. This is what checkpoints count. */
  | { kind: "stop"; at: string; text?: string }
  | ({ kind: "tool"; at: string } & ToolEvidence)
  | { kind: "subagent"; at: string; agentType: string };

export interface ToolEvidence {
  tool: string;
  failed: boolean | null;
  path?: string;
  /** Characters a write changed. The content itself is never kept. */
  changedChars?: number;
  command?: string;
  commandKind?: "test" | "build" | "shell";
  preview?: string;
  error?: string;
  detail?: Record<string, string>;
  subagent?: boolean;
}

export interface SessionState {
  host: string;
  sessionId: string;
  cwd: string;
  /** Pinned on first sight, so a `cd` mid-session doesn't change where memories go. */
  repo: RepoIdentity;
  createdAt: string;
  updatedAt: string;
  prompts: number;
  /** Recall has run for this session, so it won't again. A failed search doesn't count. */
  recallDone: boolean;
  recalled: { ids: string[]; block: string } | null;
  /** Found memories this host can only take later, with a tool result. */
  undelivered: string | null;
  connectNoticeGiven: boolean;
}

export const sessionDir = (host: string, sessionId: string) =>
  join(
    paths().sessions,
    createHash("sha256").update(`${host}\0${sessionId}`).digest("hex").slice(0, SESSION_ID_CHARS),
  );

const stateFile = (dir: string) => join(dir, "state.json");
const eventsFile = (dir: string) => join(dir, "events.jsonl");
const offsetFile = (dir: string) => join(dir, "offset");

/**
 * Bytes of the event log already turned into a packet. It has its own file, written only while
 * holding the flush lock: state is rewritten by every hook, which could put an old value back.
 */
export const readOffset = (dir: string) =>
  readFile(offsetFile(dir), "utf8").then(
    (raw) => Number(raw) || 0,
    () => 0,
  );

export const writeOffset = (dir: string, offset: number) =>
  writePrivate(offsetFile(dir), String(offset));

export async function readState(dir: string): Promise<SessionState | null> {
  try {
    return JSON.parse(await readFile(stateFile(dir), "utf8")) as SessionState;
  } catch {
    return null;
  }
}

export const writeState = (dir: string, state: SessionState) =>
  writePrivate(
    stateFile(dir),
    `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() })}\n`,
  );

/** The session's folder and state, set up the first time anything is heard from it. */
export async function openSession(
  host: string,
  sessionId: string,
  cwd: string,
): Promise<{ dir: string; state: SessionState }> {
  const dir = sessionDir(host, sessionId);
  const existing = await readState(dir);
  if (existing) return { dir, state: existing };
  const now = new Date().toISOString();
  const state: SessionState = {
    host,
    sessionId,
    cwd,
    repo: await identifyRepo(cwd),
    createdAt: now,
    updatedAt: now,
    prompts: 0,
    recallDone: false,
    recalled: null,
    undelivered: null,
    connectNoticeGiven: false,
  };
  await ensureDir(dir);
  await writeState(dir, state);
  return { dir, state };
}

/** One write in append mode: hooks running side by side can't tear each other's lines. */
export async function appendEvent(dir: string, event: SessionEvent): Promise<void> {
  const line = `${JSON.stringify(event)}\n`;
  try {
    await appendFile(eventsFile(dir), line, { mode: FILE_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    await ensureDir(dir);
    await appendFile(eventsFile(dir), line, { mode: FILE_MODE });
  }
}

export interface ReadEvent {
  event: SessionEvent;
  /** Where the log stands once this event is consumed. */
  end: number;
}

/** What's in the log after `offset`. A half-written last line is left for next time. */
export async function readEvents(dir: string, offset: number): Promise<ReadEvent[]> {
  let raw: Buffer;
  try {
    raw = await readFile(eventsFile(dir));
  } catch {
    return [];
  }
  const out: ReadEvent[] = [];
  let at = Math.min(offset, raw.length);
  while (at < raw.length) {
    const newline = raw.indexOf(0x0a, at);
    if (newline < 0) break;
    const end = newline + 1;
    try {
      out.push({ event: JSON.parse(raw.subarray(at, newline).toString("utf8")), end });
    } catch {
      // A damaged line costs that line only.
    }
    at = end;
  }
  return out;
}

export const logSize = (dir: string) =>
  stat(eventsFile(dir)).then(
    (found) => found.size,
    () => 0,
  );

/** When a session last did anything. A long turn only appends, so the log says more than state. */
export const lastActive = async (dir: string): Promise<number> => {
  const times = await Promise.all(
    [eventsFile(dir), stateFile(dir), dir].map((path) =>
      stat(path).then(
        (found) => found.mtimeMs,
        () => 0,
      ),
    ),
  );
  return Math.max(...times);
};

/**
 * Runs `work` if nobody else is, by making a folder: that's atomic everywhere. The holder keeps it
 * fresh while it works, so only a crashed holder's lock ever looks stale, and it only ever removes
 * its own.
 */
export async function withLock<T>(
  path: string,
  work: () => Promise<T>,
  { waitMs = 0 }: { waitMs?: number } = {},
): Promise<T | undefined> {
  const deadline = Date.now() + waitMs;
  const owner = randomUUID();
  const ownerFile = join(path, "owner");
  for (;;) {
    try {
      await ensureDir(join(path, ".."));
      await mkdir(path, { mode: DIR_MODE });
      await writeFile(ownerFile, owner);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const held = await stat(path).then(
        (found) => Date.now() - found.mtimeMs,
        () => 0,
      );
      if (held > STALE_LOCK_MS) {
        await rm(path, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) return undefined;
      await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
    }
  }
  const heartbeat = setInterval(() => {
    const now = new Date();
    utimes(path, now, now).catch(() => undefined);
  }, LOCK_HEARTBEAT_MS);
  heartbeat.unref();
  try {
    return await work();
  } finally {
    clearInterval(heartbeat);
    const holder = await readFile(ownerFile, "utf8").catch(() => null);
    if (holder === owner) await rm(path, { recursive: true, force: true });
  }
}

export const isPaused = () =>
  open(paths().paused, "r").then(
    async (file) => {
      await file.close();
      return true;
    },
    () => false,
  );
