import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, readdir, readFile, rename, rm, stat, utimes } from "node:fs/promises";
import { join } from "node:path";
import { ensureCli, nodeBinary, runCli } from "./cli.js";
import {
  ABANDONED_AFTER_MS,
  EXIT_AUTH,
  EXIT_LIMITED,
  EXIT_NETWORK,
  FLUSH_TIMEOUT_MS,
  MAINTAIN_EVERY_MS,
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
import { connected, type SearchScope, settings } from "./settings.js";
import {
  appendEvent,
  isPaused,
  logSize,
  openSession,
  readEvents,
  readState,
  sessionDir,
  withLock,
  writeState,
} from "./store.js";

export interface PluginContext {
  host: string;
  /** This plugin's memdot-plugin.mjs: what background work is started from. */
  script: string;
  /** This host can't take context with a prompt, only with a later tool result. */
  deliversOnTool?: boolean;
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

async function pendingPackets(): Promise<string[]> {
  try {
    return (await readdir(paths().pending)).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

async function readPacket(file: string): Promise<Packet | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Packet;
  } catch {
    return null;
  }
}

async function sendPacket(host: string, packet: Packet) {
  const scope = ["-u", packet.userId, "--agent-id", packet.repoId, "--run-id", packet.sessionId];
  const metadata = ["-m", JSON.stringify(packet.metadata)];
  const conversation = join(paths().pending, `${packet.id}.messages`);
  await writePrivate(conversation, JSON.stringify(packet.messages));
  try {
    const sent = await runCli(
      host,
      [
        "add",
        "-f",
        conversation,
        ...scope,
        ...metadata,
        "--prompt",
        CHECKPOINT_INSTRUCTIONS,
        "--categories",
        JSON.stringify(CHECKPOINT_CATEGORIES),
      ],
      { timeoutMs: FLUSH_TIMEOUT_MS },
    );
    // A Private namespace with no model set: there's nothing to extract with, so keep a note.
    if (sent.error?.code === "MODEL_REQUIRED") {
      return runCli(host, ["add", "--no-infer", ...scope, ...metadata], {
        input: packet.note,
        timeoutMs: FLUSH_TIMEOUT_MS,
      });
    }
    return sent;
  } finally {
    await rm(conversation, { force: true });
  }
}

function retryDelay(exit: number): number | null {
  if (exit === EXIT_NETWORK) return RETRY_NETWORK_MS;
  if (exit === EXIT_AUTH) return RETRY_AUTH_MS;
  if (exit === EXIT_LIMITED) return RETRY_LIMITED_MS;
  return null;
}

/** Sends what's waiting, oldest first. What can't go now stays on disk with the reason. */
export async function deliverPending(host: string): Promise<void> {
  await withLock(paths().deliverLock, async () => {
    const attempted = new Set<string>();
    for (;;) {
      const names = (await pendingPackets()).filter((name) => !attempted.has(name));
      if (names.length === 0) return;
      for (const name of names) {
        attempted.add(name);
        const file = join(paths().pending, name);
        const packet = await readPacket(file);
        if (!packet) {
          await rm(file, { force: true });
          continue;
        }
        const expired = Date.now() - Date.parse(packet.createdAt) > PACKET_TTL_MS;
        if (expired || packet.attempts >= MAX_PACKET_ATTEMPTS) {
          await ensureDir(paths().failed);
          await rename(file, join(paths().failed, name));
          continue;
        }
        if (packet.notBefore > Date.now()) continue;
        const sent = await sendPacket(packet.host || host, packet);
        if (sent.ok) {
          await rm(file, { force: true });
          continue;
        }
        const wait = retryDelay(sent.exit);
        await writePrivate(
          file,
          JSON.stringify({
            ...packet,
            // Only a failure of this packet counts against it: a network or a limit isn't one.
            attempts: wait === null ? packet.attempts + 1 : packet.attempts,
            notBefore: Date.now() + (wait ?? RETRY_FAILED_MS),
            lastError: sent.error?.message ?? "It failed.",
          } satisfies Packet),
        );
      }
    }
  });
}

/** Turns what a session has logged into a packet. The log's position moves in the same step. */
export async function prepareFlush(dir: string, force: boolean): Promise<void> {
  await withLock(join(dir, "flush.lock"), async () => {
    const state = await readState(dir);
    if (!state) return;
    const events = await readEvents(dir, state.offset);
    const { checkpointExchanges, userId } = settings();
    const count = selectCheckpoint(events, { force, exchanges: checkpointExchanges });
    if (count === 0) return;
    const taken = events.slice(0, count);
    const packet = buildPacket(taken, state, userId);
    if (packet) {
      await writePrivate(join(paths().pending, `${packet.id}.json`), JSON.stringify(packet));
    }
    await writeState(dir, { ...state, offset: taken.at(-1)?.end ?? state.offset });
  });
}

/** A session that crashed never got to flush. Old ones go once there's nothing left in them. */
async function sweepSessions(): Promise<void> {
  const { sessions } = paths();
  const names = await readdir(sessions).catch(() => [] as string[]);
  for (const name of names) {
    const dir = join(sessions, name);
    const state = await readState(dir);
    if (!state) continue;
    const idle = Date.now() - Date.parse(state.updatedAt);
    const unsaved = (await logSize(dir)) > state.offset;
    if (unsaved && idle > ABANDONED_AFTER_MS) await prepareFlush(dir, true);
    if (idle > SESSION_TTL_MS) await rm(dir, { recursive: true, force: true });
  }
  const failed = await readdir(paths().failed).catch(() => [] as string[]);
  for (const name of failed) {
    const file = join(paths().failed, name);
    const age = await stat(file).then(
      (found) => Date.now() - found.mtimeMs,
      () => 0,
    );
    if (age > SESSION_TTL_MS) await rm(file, { force: true });
  }
}

/** What runs in the background from a session start: everything a hook has no time for. */
export async function maintain(host: string): Promise<void> {
  await ensureCli();
  if (!connected() || (await isPaused())) return;
  await refreshConnection(host);
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

export async function onSessionStart(
  context: PluginContext,
  input: SessionInput & { source?: string; canAddContext?: boolean },
): Promise<HookOutput> {
  await installLauncher(context.script).catch((error) => logError("launcher", error));
  if (await maintenanceDue()) startWorker(context, "maintain");
  if (await isPaused()) return {};
  const { dir, state } = await openSession(context.host, input.sessionId, input.cwd);
  if (!connected()) {
    // Where a host can't take it here, the first prompt says it instead.
    if (state.connectNoticeGiven || input.canAddContext === false) return {};
    await writeState(dir, { ...state, connectNoticeGiven: true });
    return { context: NOT_CONNECTED };
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
  if (!connected()) {
    if (state.connectNoticeGiven) return {};
    await writeState(dir, { ...state, connectNoticeGiven: true });
    return { context: NOT_CONNECTED };
  }
  const prompt = bounded(input.prompt, MAX_MESSAGE_CHARS);
  await appendEvent(dir, { kind: "prompt", at: new Date().toISOString(), text: prompt });
  const first = state.prompts === 0;
  await writeState(dir, { ...state, prompts: state.prompts + 1 });
  if (!first || prompt.length < MIN_QUERY_CHARS || !(await recallReady())) return {};

  const options = settings();
  const { memories, error } = await searchMemories(context.host, prompt, {
    scope: options.searchScope,
    repo: state.repo,
    topK: RECALL_TOP_K,
    timeoutMs: RECALL_TIMEOUT_MS,
  });
  if (error) await logError("recall", error);
  const block = formatMemories(memories, { limit: options.maxContextChars });
  if (!block) return {};
  const latest = (await readState(dir)) ?? state;
  await writeState(dir, {
    ...latest,
    recalled: { ids: memories.map((memory) => memory.id), block },
    undelivered: context.deliversOnTool ? block : null,
  });
  return context.deliversOnTool ? {} : { context: block };
}

/** The hot path, on every tool call: one line appended and nothing else. */
export async function onTool(
  context: PluginContext,
  input: SessionInput & ToolInput,
): Promise<HookOutput> {
  if ((await isPaused()) || !connected()) return {};
  const dir = sessionDir(context.host, input.sessionId);
  await appendEvent(dir, { kind: "tool", at: new Date().toISOString(), ...evidenceFrom(input) });
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
  if ((await isPaused()) || !connected() || !input.message) return;
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
  if ((await isPaused()) || !connected()) return;
  const { dir, state } = await openSession(context.host, input.sessionId, input.cwd);
  await appendEvent(dir, {
    kind: "stop",
    at: new Date().toISOString(),
    ...(input.message ? { text: bounded(input.message, MAX_MESSAGE_CHARS) } : {}),
  });
  await writeState(dir, state);
  const options = settings();
  if (!options.autoSave) return;
  const events = await readEvents(dir, state.offset);
  if (selectCheckpoint(events, { force: false, exchanges: options.checkpointExchanges }) > 0) {
    startWorker(context, "flush", dir);
  }
}

/** Compaction and the end of a session: everything so far is saved, in the background. */
export async function onFlush(
  context: PluginContext,
  input: SessionInput & { message?: string },
): Promise<void> {
  if ((await isPaused()) || !connected()) return;
  const { dir } = await openSession(context.host, input.sessionId, input.cwd);
  if (input.message) await onAssistant(context, { ...input, message: input.message });
  if (settings().autoSave) startWorker(context, "flush", dir, "--force");
}

export async function onSubagentStart(
  context: PluginContext,
  input: SessionInput & { agentType: string },
): Promise<HookOutput> {
  if ((await isPaused()) || !connected()) return {};
  const { dir, state } = await openSession(context.host, input.sessionId, input.cwd);
  await appendEvent(dir, {
    kind: "subagent",
    at: new Date().toISOString(),
    agentType: bounded(input.agentType, 200),
  });
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
