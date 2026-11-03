import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, readdir, readFile, rename, rm, stat, utimes } from "node:fs/promises";
import { basename, join } from "node:path";
import { ensureCli, nodeBinary, runCli } from "./cli.js";
import {
  ABANDONED_AFTER_MS,
  EXIT_AUTH,
  EXIT_LIMITED,
  EXIT_NETWORK,
  EXIT_NOT_FOUND,
  EXIT_USAGE,
  FAILED_TTL_MS,
  FLUSH_TIMEOUT_MS,
  MAINTAIN_EVERY_MS,
  MAX_FIELD_CHARS,
  MAX_MESSAGE_CHARS,
  MAX_PACKET_ATTEMPTS,
  MAX_QUERY_CHARS,
  MIN_QUERY_CHARS,
  PACKET_TTL_MS,
  RECALL_TIMEOUT_MS,
  RECALL_TOP_K,
  RETRY_AUTH_MS,
  RETRY_FAILED_MS,
  RETRY_LIMITED_MS,
  RETRY_NETWORK_MS,
  RETRY_OTHER_LOGIN_MS,
  SESSION_TTL_MS,
  WARM_TIMEOUT_MS,
} from "./constants.js";
import { evidenceFrom, type ToolInput } from "./evidence.js";
import { buildPacket, type Packet, selectCheckpoint } from "./packet.js";
import { ensureDir, logError, paths, writePrivate } from "./paths.js";
import {
  CHECKPOINT_CATEGORIES,
  CHECKPOINT_INSTRUCTIONS,
  formatMemories,
  NOT_CONNECTED,
  type RecalledMemory,
} from "./prompts.js";
import { bounded } from "./redact.js";
import type { RepoIdentity } from "./repo.js";
import { connected, keepHostOptions, type SearchScope, settings, writeTarget } from "./settings.js";
import {
  appendEvent,
  isPaused,
  lastActive,
  logSize,
  openSession,
  readEvents,
  readOffset,
  readState,
  type SessionState,
  sessionDir,
  withLock,
  writeOffset,
  writeState,
} from "./store.js";

export interface PluginContext {
  host: string;
  /** This plugin's memdot-plugin.mjs: what background work is started from. */
  script: string;
  /** This host can't take context with a prompt, only with a later tool result. */
  deliversOnTool?: boolean;
  /** This host can't show anything at session start, so a notice waits for the first prompt. */
  quietStart?: boolean;
}

/** What goes back to the host. Each host says it differently; see hosts/. */
export interface HookOutput {
  context?: string;
}

/** The memories a search should reach. Your own preferences follow you between repositories. */
export function scopeFilter(
  scope: SearchScope,
  repoId: string,
  userId: string,
): Record<string, unknown> | undefined {
  if (scope === "all") return undefined;
  const mine = { user_id: userId };
  if (scope === "mine") return mine;
  return {
    OR: [{ agent_id: repoId }, { AND: [mine, { categories: { in: ["user_preferences"] } }] }],
  };
}

export async function searchMemories(
  host: string,
  query: string,
  options: { scope: SearchScope; repo: RepoIdentity; topK: number; timeoutMs?: number },
): Promise<{ memories: RecalledMemory[]; error: string | null }> {
  const filter = scopeFilter(options.scope, options.repo.id, settings().userId);
  const result = await runCli(
    host,
    ["search", "-k", String(options.topK), ...(filter ? ["--filter", JSON.stringify(filter)] : [])],
    { input: bounded(query, MAX_QUERY_CHARS), timeoutMs: options.timeoutMs },
  );
  if (!result.ok) return { memories: [], error: result.error?.message ?? "Search failed." };
  return { memories: (result.data as RecalledMemory[]) ?? [], error: null };
}

// ── Background work ────────────────────────────────────────────────────────────────────────────

/** Starts work that outlives this hook. The host isn't kept waiting and can't kill it by accident. */
export function startWorker(context: PluginContext, ...args: string[]): void {
  const child = spawn(nodeBinary(), [context.script, "worker", context.host, ...args], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.on("error", (error) => void logError("worker", error));
  child.unref();
}

/** A stable path for skills, since most hosts can't tell a skill where its plugin is installed. */
export async function installLauncher(script: string): Promise<void> {
  const { launcher } = paths();
  const [mine, theirs] = await Promise.all([
    readFile(script),
    readFile(launcher).catch(() => null),
  ]);
  if (theirs?.equals(mine)) return;
  await ensureDir(join(launcher, ".."));
  const temporary = `${launcher}.${randomUUID()}.tmp`;
  await copyFile(script, temporary);
  await rename(temporary, launcher);
}

interface Connection {
  namespaceId: string | null;
  mode: "private" | "assisted" | null;
  privateReady: boolean;
}

async function readConnection(): Promise<Connection | null> {
  try {
    return JSON.parse(await readFile(paths().connection, "utf8")) as Connection;
  } catch {
    return null;
  }
}

/**
 * Private recall embeds on this machine. The first time pulls down a runtime and a model, which a
 * hook's time limit would cut short, so hooks don't search until maintenance has done that once.
 */
async function recallReady(): Promise<boolean> {
  const connection = await readConnection();
  return connection?.mode === "assisted" || connection?.privateReady === true;
}

async function refreshConnection(host: string): Promise<void> {
  const listed = await runCli(host, ["namespace", "ls"]);
  if (!listed.ok) return;
  const data = listed.data as {
    default_namespace_id: string | null;
    namespaces: { id: string; mode: "private" | "assisted" }[];
  };
  const namespaceId = data.default_namespace_id;
  const mode = namespaceId
    ? (data.namespaces.find((row) => row.id === namespaceId)?.mode ?? null)
    : "assisted";
  const previous = await readConnection();
  let privateReady = previous?.namespaceId === namespaceId && previous?.privateReady === true;
  if (mode === "private" && !privateReady) {
    const warmed = await runCli(host, ["search", "-k", "1"], {
      input: "warm up",
      timeoutMs: WARM_TIMEOUT_MS,
    });
    privateReady = warmed.ok;
  }
  await writePrivate(
    paths().connection,
    `${JSON.stringify({ namespaceId, mode, privateReady } satisfies Connection)}\n`,
  );
}

/** What's waiting, oldest first. A packet that can't be read right now just waits its turn. */
async function pendingPackets(): Promise<{ file: string; packet: Packet }[]> {
  const dir = paths().pending;
  const names = await readdir(dir).catch(() => [] as string[]);
  const found: { file: string; packet: Packet }[] = [];
  for (const name of names.filter((entry) => entry.endsWith(".json"))) {
    const file = join(dir, name);
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch {
      continue;
    }
    try {
      found.push({ file, packet: JSON.parse(raw) as Packet });
    } catch {
      // Packets are replaced in one step, so a damaged one can never be finished later.
      await rm(file, { force: true });
    }
  }
  return found.sort((a, b) => a.packet.createdAt.localeCompare(b.packet.createdAt));
}

async function sendPacket(host: string, packet: Packet) {
  const target = [
    ...(packet.namespaceId ? ["-n", packet.namespaceId] : []),
    "-u",
    packet.userId,
    "--agent-id",
    packet.repoId,
    "--run-id",
    packet.sessionId,
    "-m",
    JSON.stringify(packet.metadata),
    "--idempotency-key",
    packet.id,
  ];
  const conversation = join(paths().pending, `${packet.id}.messages`);
  await writePrivate(conversation, JSON.stringify(packet.messages));
  try {
    const sent = await runCli(
      host,
      [
        "add",
        "-f",
        conversation,
        ...target,
        "--prompt",
        CHECKPOINT_INSTRUCTIONS,
        "--categories",
        JSON.stringify(CHECKPOINT_CATEGORIES),
      ],
      { timeoutMs: FLUSH_TIMEOUT_MS },
    );
    // A Private namespace with no model set: there's nothing to extract with, so keep a note.
    if (sent.error?.code === "MODEL_REQUIRED") {
      return runCli(host, ["add", "--no-infer", ...target], {
        input: packet.note,
        timeoutMs: FLUSH_TIMEOUT_MS,
      });
    }
    return sent;
  } finally {
    await rm(conversation, { force: true });
  }
}

/** How long to wait, for failures that say nothing about the packet itself. */
function retryDelay(exit: number): number | null {
  if (exit === EXIT_USAGE || exit === EXIT_NOT_FOUND) return null;
  if (exit === EXIT_NETWORK) return RETRY_NETWORK_MS;
  if (exit === EXIT_AUTH) return RETRY_AUTH_MS;
  if (exit === EXIT_LIMITED) return RETRY_LIMITED_MS;
  return RETRY_FAILED_MS;
}

const hold = (file: string, packet: Packet, waitMs: number, reason: string) =>
  writePrivate(
    file,
    JSON.stringify({
      ...packet,
      notBefore: Date.now() + waitMs,
      lastError: bounded(reason, MAX_FIELD_CHARS),
    } satisfies Packet),
  );

/** Sends what's waiting. What can't go now stays on disk with the reason. */
export async function deliverPending(host: string): Promise<void> {
  await withLock(paths().deliverLock, async () => {
    const attempted = new Set<string>();
    for (;;) {
      const waiting = (await pendingPackets()).filter(({ file }) => !attempted.has(file));
      if (waiting.length === 0) return;
      const { loginId } = writeTarget();
      for (const { file, packet } of waiting) {
        attempted.add(file);
        const expired = Date.now() - Date.parse(packet.createdAt) > PACKET_TTL_MS;
        if (expired || packet.attempts >= MAX_PACKET_ATTEMPTS) {
          await ensureDir(paths().failed);
          await rename(file, join(paths().failed, basename(file)));
          continue;
        }
        if (packet.notBefore > Date.now()) continue;
        // A conversation goes to the account it came from, whoever is logged in by now.
        if (packet.loginId !== loginId) {
          await hold(file, packet, RETRY_OTHER_LOGIN_MS, "Saved under a different login.");
          continue;
        }
        const sent = await sendPacket(packet.host || host, packet);
        if (sent.ok) {
          await rm(file, { force: true });
          continue;
        }
        const reason = sent.error?.message ?? "It failed.";
        const wait = retryDelay(sent.exit);
        await hold(
          file,
          // Only a failure of this packet counts against it: an outage or a limit isn't one.
          wait === null ? { ...packet, attempts: packet.attempts + 1 } : packet,
          wait ?? RETRY_FAILED_MS,
          reason,
        );
      }
    }
  });
}

/** Turns what a session has logged into a packet. The log's position moves only once that's safe. */
export async function prepareFlush(dir: string, force: boolean): Promise<void> {
  await withLock(join(dir, "flush.lock"), async () => {
    const state = await readState(dir);
    if (!state) return;
    const offset = await readOffset(dir);
    const events = await readEvents(dir, offset);
    const { checkpointExchanges, userId } = settings();
    const count = selectCheckpoint(events, { force, exchanges: checkpointExchanges });
    if (count === 0) return;
    const taken = events.slice(0, count);
    const packet = buildPacket(taken, state, { userId, ...writeTarget() });
    if (packet) {
      await writePrivate(join(paths().pending, `${packet.id}.json`), JSON.stringify(packet));
    }
    await writeOffset(dir, taken.at(-1)?.end ?? offset);
  });
}

/** A session that crashed never got to flush. What's left of an old one goes once it's saved. */
async function sweepSessions(): Promise<void> {
  const { sessions, failed: failedDir } = paths();
  const names = await readdir(sessions).catch(() => [] as string[]);
  for (const name of names) {
    const dir = join(sessions, name);
    const idle = Date.now() - (await lastActive(dir));
    const state = await readState(dir);
    if (!state) {
      if (idle > SESSION_TTL_MS) await rm(dir, { recursive: true, force: true });
      continue;
    }
    const unsaved = (await logSize(dir)) > (await readOffset(dir));
    if (unsaved && idle > ABANDONED_AFTER_MS) await prepareFlush(dir, true);
    const stillUnsaved = (await logSize(dir)) > (await readOffset(dir));
    if (!stillUnsaved && idle > SESSION_TTL_MS) await rm(dir, { recursive: true, force: true });
  }
  const failed = await readdir(failedDir).catch(() => [] as string[]);
  for (const name of failed) {
    const file = join(failedDir, name);
    const age = await stat(file).then(
      (found) => Date.now() - found.mtimeMs,
      () => 0,
    );
    if (age > FAILED_TTL_MS) await rm(file, { force: true });
  }
}

/** What runs in the background from a session start: everything a hook has no time for. */
export async function maintain(host: string): Promise<void> {
  await ensureCli();
  if (!connected() || (await isPaused())) return;
  await refreshConnection(host);
  if (!settings().autoSave) return;
  await sweepSessions();
  await deliverPending(host);
}

async function maintenanceDue(): Promise<boolean> {
  const { maintained } = paths();
  const age = await stat(maintained).then(
    (found) => Date.now() - found.mtimeMs,
    () => Number.POSITIVE_INFINITY,
  );
  if (age < MAINTAIN_EVERY_MS) return false;
  const now = new Date();
  await utimes(maintained, now, now).catch(() => writePrivate(maintained, ""));
  return true;
}

// ── Hooks ──────────────────────────────────────────────────────────────────────────────────────

export interface SessionInput {
  sessionId: string;
  cwd: string;
}

/** Tell someone once that nothing is happening, at the first moment their host can show it. */
async function connectNotice(dir: string, state: SessionState): Promise<HookOutput> {
  if (state.connectNoticeGiven) return {};
  await writeState(dir, { ...state, connectNoticeGiven: true });
  return { context: NOT_CONNECTED };
}

export async function onSessionStart(
  context: PluginContext,
  input: SessionInput & { source?: string },
): Promise<HookOutput> {
  await installLauncher(context.script).catch((error) => logError("launcher", error));
  await keepHostOptions().catch((error) => logError("options", error));
  if (await maintenanceDue()) startWorker(context, "maintain");
  if (await isPaused()) return {};
  const { dir, state } = await openSession(context.host, input.sessionId, input.cwd);
  if (!connected()) {
    // Where a host can't take it here, the first prompt says it instead.
    return context.quietStart ? {} : connectNotice(dir, state);
  }
  // Compaction just dropped what was recalled earlier, so it comes back.
  if (input.source === "compact" && state.recalled?.block) return { context: state.recalled.block };
  return {};
}

export async function onPrompt(
  context: PluginContext,
  input: SessionInput & { prompt: string },
): Promise<HookOutput> {
  if (await isPaused()) return {};
  const { dir, state } = await openSession(context.host, input.sessionId, input.cwd);
  if (!connected()) return connectNotice(dir, state);
  const options = settings();
  const prompt = bounded(input.prompt, MAX_MESSAGE_CHARS);
  if (options.autoSave) {
    await appendEvent(dir, { kind: "prompt", at: new Date().toISOString(), text: prompt });
  }
  await writeState(dir, { ...state, prompts: state.prompts + 1 });
  // A short first prompt or a failed search doesn't use up the session's one recall.
  if (state.recallDone || prompt.length < MIN_QUERY_CHARS || !(await recallReady())) return {};

  const { memories, error } = await searchMemories(context.host, prompt, {
    scope: options.searchScope,
    repo: state.repo,
    topK: RECALL_TOP_K,
    timeoutMs: RECALL_TIMEOUT_MS,
  });
  if (error) {
    await logError("recall", error);
    return {};
  }
  const block = formatMemories(memories, { limit: options.maxContextChars });
  const latest = (await readState(dir)) ?? state;
  await writeState(dir, {
    ...latest,
    recallDone: true,
    recalled: block ? { ids: memories.map((memory) => memory.id), block } : null,
    undelivered: block && context.deliversOnTool ? block : null,
  });
  return block && !context.deliversOnTool ? { context: block } : {};
}

/** The hot path, on every tool call: one line appended and nothing else. */
export async function onTool(
  context: PluginContext,
  input: SessionInput & ToolInput,
): Promise<HookOutput> {
  if ((await isPaused()) || !connected()) return {};
  const dir = sessionDir(context.host, input.sessionId);
  if (settings().autoSave) {
    await appendEvent(dir, { kind: "tool", at: new Date().toISOString(), ...evidenceFrom(input) });
  }
  if (!context.deliversOnTool) return {};
  const state = await readState(dir);
  if (!state?.undelivered) return {};
  await writeState(dir, { ...state, undelivered: null });
  return { context: state.undelivered };
}

export async function onAssistant(
  context: PluginContext,
  input: SessionInput & { message: string },
): Promise<void> {
  if ((await isPaused()) || !connected() || !input.message || !settings().autoSave) return;
  const { dir } = await openSession(context.host, input.sessionId, input.cwd);
  await appendEvent(dir, {
    kind: "assistant",
    at: new Date().toISOString(),
    text: bounded(input.message, MAX_MESSAGE_CHARS),
  });
}

export async function onStop(
  context: PluginContext,
  input: SessionInput & { message?: string },
): Promise<void> {
  const options = settings();
  if ((await isPaused()) || !connected() || !options.autoSave) return;
  const { dir, state } = await openSession(context.host, input.sessionId, input.cwd);
  await appendEvent(dir, {
    kind: "stop",
    at: new Date().toISOString(),
    ...(input.message ? { text: bounded(input.message, MAX_MESSAGE_CHARS) } : {}),
  });
  await writeState(dir, state);
  const events = await readEvents(dir, await readOffset(dir));
  if (selectCheckpoint(events, { force: false, exchanges: options.checkpointExchanges }) > 0) {
    startWorker(context, "flush", dir);
  }
}

/** Compaction and the end of a session: everything so far is saved, in the background. */
export async function onFlush(
  context: PluginContext,
  input: SessionInput & { message?: string },
): Promise<void> {
  if ((await isPaused()) || !connected() || !settings().autoSave) return;
  const { dir } = await openSession(context.host, input.sessionId, input.cwd);
  if (input.message) await onAssistant(context, { ...input, message: input.message });
  startWorker(context, "flush", dir, "--force");
}

export async function onSubagentStart(
  context: PluginContext,
  input: SessionInput & { agentType: string },
): Promise<HookOutput> {
  if ((await isPaused()) || !connected()) return {};
  const { dir, state } = await openSession(context.host, input.sessionId, input.cwd);
  if (settings().autoSave) {
    await appendEvent(dir, {
      kind: "subagent",
      at: new Date().toISOString(),
      agentType: bounded(input.agentType, MAX_FIELD_CHARS),
    });
  }
  return state.recalled?.block ? { context: state.recalled.block } : {};
}

/** What a subagent reported goes into the next checkpoint, marked as its report. */
export async function onSubagentStop(
  context: PluginContext,
  input: SessionInput & { agentType: string; message?: string },
): Promise<void> {
  if (!input.message) return;
  await onAssistant(context, {
    ...input,
    message: `Subagent report (${input.agentType}):\n${input.message}`,
  });
}
