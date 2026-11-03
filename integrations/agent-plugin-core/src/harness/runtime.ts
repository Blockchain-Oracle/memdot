import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGIN_VERSION } from "../constants.js";
import type { ToolInput } from "../evidence.js";
import {
  type HookOutput,
  installLauncher,
  onAssistant,
  onFlush,
  onPrompt,
  onSessionStart,
  onStop,
  onTool,
  type PluginContext,
  type SessionInput,
} from "../lifecycle.js";
import { logError } from "../paths.js";

/** A hook must never break the host: what goes wrong is kept for `status`. */
async function safely<T>(where: string, work: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    await logError(where, error);
    return fallback;
  }
}

/**
 * The same lifecycle the hook hosts run, for hosts that load a plugin in-process. The bundle sits
 * next to the launcher, so background work can start from it.
 */
export function createRuntime(host: string, moduleUrl: string) {
  const core = dirname(fileURLToPath(moduleUrl));
  const context: PluginContext = { host, script: join(core, "memdot-plugin.mjs") };
  const none: HookOutput = {};
  return {
    host,
    version: PLUGIN_VERSION,
    script: context.script,
    skillsDir: join(core, "..", "skills"),
    start: (input: SessionInput & { source?: string }) =>
      safely(`${host} start`, () => onSessionStart(context, input), none),
    prompt: (input: SessionInput & { prompt: string }) =>
      safely(`${host} prompt`, () => onPrompt(context, input), none),
    tool: (input: SessionInput & ToolInput) =>
      safely(`${host} tool`, () => onTool(context, input), none),
    assistant: (input: SessionInput & { message: string }) =>
      safely(`${host} assistant`, () => onAssistant(context, input), undefined),
    stop: (input: SessionInput & { message?: string }) =>
      safely(`${host} stop`, () => onStop(context, input), undefined),
    flush: (input: SessionInput & { message?: string }) =>
      safely(`${host} flush`, () => onFlush(context, input), undefined),
    installLauncher: () => installLauncher(context.script),
  };
}

/** Message text, whichever way a host holds it: a string, or a list of typed parts. */
export function messageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const { content } = message as { content?: unknown };
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part) => part && typeof part === "object" && (part as { type?: string }).type === "text",
    )
    .map((part) => (part as { text?: string }).text ?? "")
    .join("\n")
    .trim();
}

export const lastAssistantText = (messages: unknown[]): string => {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: string };
    if (message?.role === "assistant") {
      const text = messageText(message);
      if (text) return text;
    }
  }
  return "";
};

export interface SkillText {
  name: string;
  description: string;
  body: string;
}

/** The skills shipped with this plugin, for hosts that take commands instead of skill folders. */
export function readSkills(skillsDir: string): SkillText[] {
  return readdirSync(skillsDir).map((name) => {
    const raw = readFileSync(join(skillsDir, name, "SKILL.md"), "utf8");
    const [, front = "", body = ""] = raw.split(/^---$/m);
    const description = front.match(/^description:\s*(.+)$/m)?.[1] ?? name;
    return { name, description, body: body.trim() };
  });
}
