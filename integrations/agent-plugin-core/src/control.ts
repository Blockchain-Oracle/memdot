import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { copyFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { findCli, runCli } from "./cli.js";
import { MAX_MESSAGE_CHARS, PLUGIN_VERSION } from "./constants.js";
import { scopeFilter, searchMemories } from "./lifecycle.js";
import { ensureDir, FILE_MODE, paths } from "./paths.js";
import { formatMemories, type RecalledMemory } from "./prompts.js";
import { bounded } from "./redact.js";
import { identifyRepo } from "./repo.js";
import { connected, SEARCH_SCOPES, type SearchScope, settings } from "./settings.js";
import { isPaused } from "./store.js";

const NOTHING_FOUND = "Nothing found.";

/** What skills and tools can do, as plain answers. A failure is an Error with words a person can use. */
export async function searchText(
  host: string,
  query: string,
  { scope, topK, cwd }: { scope?: string | undefined; topK?: number | undefined; cwd: string },
): Promise<string> {
  const options = settings();
  if (scope && !SEARCH_SCOPES.includes(scope as SearchScope)) {
    throw new Error(`Scope is one of ${SEARCH_SCOPES.join(", ")}.`);
  }
  const { memories, error } = await searchMemories(host, query, {
    scope: (scope as SearchScope | undefined) ?? options.searchScope,
    repo: await identifyRepo(cwd),
    topK: topK ?? options.topK,
  });
  if (error) throw new Error(error);
  const text = formatMemories(memories, { heading: "", limit: options.maxContextChars });
  if (!text) return NOTHING_FOUND;
  return `${text}\n\nIds: ${memories.map((memory) => memory.id).join(" ")}`;
}

export async function rememberText(host: string, text: string, cwd: string): Promise<string> {
  const fact = bounded(text, MAX_MESSAGE_CHARS);
  if (!fact) throw new Error("Say what to remember.");
  const repo = await identifyRepo(cwd);
  const result = await runCli(
    host,
    [
      "add",
      "--no-infer",
      "-u",
      settings().userId,
      "--agent-id",
      repo.id,
      "-m",
      JSON.stringify({ source: "plugin_remember", repo: repo.name }),
    ],
    { input: fact },
  );
  if (!result.ok) throw new Error(result.error?.message ?? "Couldn't save it.");
  const added = (result.data as { results?: { id: string; memory: string }[] }).results ?? [];
  return added.length
    ? `Remembered: ${added.map((memory) => `${memory.memory} (${memory.id})`).join("; ")}`
    : "That's already remembered.";
}

export async function listText(
  host: string,
  { scope, limit, cwd }: { scope?: string | undefined; limit?: number | undefined; cwd: string },
): Promise<string> {
  const options = settings();
  const repo = await identifyRepo(cwd);
  const filter = scopeFilter(
    (scope as SearchScope) ?? options.searchScope,
    repo.id,
    options.userId,
  );
  const result = await runCli(host, [
    "list",
    "--page-size",
    String(limit ?? options.topK),
    ...(filter ? ["--filter", JSON.stringify(filter)] : []),
  ]);
  if (!result.ok) throw new Error(result.error?.message ?? "Couldn't list them.");
  const data = result.data as { results?: RecalledMemory[] } | RecalledMemory[];
  const memories = Array.isArray(data) ? data : (data.results ?? []);
  if (memories.length === 0) return NOTHING_FOUND;
  return memories.map((memory) => `${memory.id}: ${memory.memory}`).join("\n");
}

export async function getText(host: string, id: string): Promise<string> {
  const result = await runCli(host, ["get", id]);
  if (!result.ok) throw new Error(result.error?.message ?? "Couldn't find it.");
  return JSON.stringify(result.data, null, 2);
}

export async function forgetIds(host: string, ids: string[]): Promise<string> {
  const lines: string[] = [];
  for (const id of ids) {
    const result = await runCli(host, ["delete", id, "--force"]);
    lines.push(result.ok ? `Forgotten: ${id}` : `Couldn't forget ${id}: ${result.error?.message}`);
  }
  return lines.join("\n");
}

/** Without `confirmed`, this only says how many would go. */
export async function forgetRepo(host: string, cwd: string, confirmed: boolean): Promise<string> {
  const repo = await identifyRepo(cwd);
  const scope = ["--agent-id", repo.id];
  if (!confirmed) {
    const preview = await runCli(host, ["delete", "--all", "--dry-run", ...scope]);
    if (!preview.ok) throw new Error(preview.error?.message ?? "Couldn't count them.");
    const { would_delete: count } = preview.data as { would_delete: number };
    return `This would forget ${count} memories saved for ${repo.name}. Nothing changed. To go ahead, run this again with --yes.`;
  }
  const result = await runCli(host, ["delete", "--all", "--force", ...scope]);
  if (!result.ok) throw new Error(result.error?.message ?? "Couldn't forget them.");
  return `Forgotten everything saved for ${repo.name}.`;
}

export async function pause(): Promise<string> {
  const { paused, plugin } = paths();
  await ensureDir(plugin);
  writeFileSync(paused, "", { mode: FILE_MODE });
  return "MemDot stopped saving and recalling on its own. Tools you call directly still work.";
}

export function resume(): string {
  rmSync(paths().paused, { force: true });
  return "MemDot is saving and recalling again. Nothing from the pause was saved.";
}

const CODEX_EVENTS: [string, string, string?][] = [
  ["SessionStart", "session-start", "startup|resume|clear|compact"],
  ["UserPromptSubmit", "prompt"],
  ["PostToolUse", "tool", ".*"],
  ["SubagentStart", "subagent-start"],
  ["SubagentStop", "subagent-stop"],
  ["Stop", "stop"],
  ["PreCompact", "compact"],
  ["SessionEnd", "session-end"],
];
const CODEX_HOOK_TIMEOUT_SECONDS = 15;
const CODEX_SESSION_END_TIMEOUT_SECONDS = 3;

interface CodexHookGroup {
  matcher?: string;
  hooks?: { type?: string; command?: string; timeout?: number }[];
}

/**
 * Adds MemDot's hooks to Codex's own hook config. Codex's CLI doesn't run hooks that come from a
 * plugin, only these, so this is a step you ask for. Anything else in the file stays as it was.
 */
export async function setupCodex(): Promise<string> {
  const home = process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  const file = join(home, "hooks.json");
  let config: { hooks?: Record<string, CodexHookGroup[]> } = {};
  try {
    config = JSON.parse(await readFile(file, "utf8"));
    await copyFile(file, `${file}.bak`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`${file} isn't valid JSON, so it was left alone.`);
    }
  }
  const hooks = { ...config.hooks };
  const runsOurs = (group: CodexHookGroup) =>
    group.hooks?.some((hook) => hook.command?.includes("memdot-plugin.mjs")) === true;
  for (const [event, action, matcher] of CODEX_EVENTS) {
    const others = (hooks[event] ?? []).filter((group) => !runsOurs(group));
    hooks[event] = [
      ...others,
      {
        ...(matcher ? { matcher } : {}),
        hooks: [
          {
            type: "command",
            command: `node "${paths().launcher}" hook codex ${action}`,
            timeout:
              event === "SessionEnd"
                ? CODEX_SESSION_END_TIMEOUT_SECONDS
                : CODEX_HOOK_TIMEOUT_SECONDS,
          },
        ],
      },
    ];
  }
  await ensureDir(home);
  writeFileSync(file, `${JSON.stringify({ ...config, hooks }, null, 2)}\n`);
  return `Added MemDot's hooks to ${file}. Open /hooks in Codex once and trust them: it skips any hook you haven't reviewed.`;
}

const packetFiles = (dir: string) => {
  try {
    return readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
};

export async function statusReport(host: string, cwd: string): Promise<Record<string, unknown>> {
  const { pending, failed, errors, connection: connectionFile } = paths();
  const waiting = await Promise.all(
    packetFiles(pending).map(async (name) =>
      JSON.parse(await readFile(join(pending, name), "utf8").catch(() => "{}")),
    ),
  );
  const repo = await identifyRepo(cwd);
  const options = settings();
  const cli = findCli();
  const who = connected() && cli ? await runCli(host, ["whoami"]) : null;
  const connection = await readFile(connectionFile, "utf8")
    .then((raw) => JSON.parse(raw))
    .catch(() => null);
  const lastError = await readFile(errors, "utf8")
    .then((raw) => raw.trim().split("\n").at(-1) ?? null)
    .catch(() => null);
  return {
    version: PLUGIN_VERSION,
    connected: connected(),
    key_works: who ? who.ok : null,
    key_problem: who && !who.ok ? (who.error?.hint ?? who.error?.message ?? null) : null,
    agent: who?.ok ? ((who.data as { agent?: { label?: string } }).agent?.label ?? null) : null,
    namespace: connection?.namespaceId ?? null,
    mode: connection?.mode ?? null,
    paused: await isPaused(),
    auto_save: options.autoSave,
    repo: repo.name,
    repo_scope: repo.id,
    user: options.userId,
    waiting_to_save: waiting.length,
    waiting_reason: waiting.find((packet) => packet.lastError)?.lastError ?? null,
    could_not_save: packetFiles(failed).length,
    cli: cli ?? "not installed yet",
    last_error: lastError,
  };
}
