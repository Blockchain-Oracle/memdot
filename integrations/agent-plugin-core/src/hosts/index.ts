import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type HookOutput,
  onAssistant,
  onFlush,
  onPrompt,
  onSessionStart,
  onStop,
  onSubagentStart,
  onSubagentStop,
  onTool,
  type PluginContext,
} from "../lifecycle.js";

type Json = Record<string, unknown>;
const str = (value: unknown) => (typeof value === "string" ? value : "");
const UNKNOWN_SESSION = "unknown-session";

interface HostAdapter {
  /** Handles one event from this host. */
  handle(context: PluginContext, event: string, input: Json): Promise<HookOutput>;
  /** What to print for it: every host reads context back differently. */
  render(event: string, output: HookOutput): string;
  deliversOnTool?: boolean;
  quietStart?: boolean;
}

const json = (value: unknown) => JSON.stringify(value);

// ── Hosts that share the same hook contract: session_id, cwd, hookSpecificOutput ───────────────

/** Whether a tool that reports no failure field actually failed. Unknown stays unknown. */
function inferFailed(response: unknown): boolean | null {
  if (!response || typeof response !== "object") return null;
  const record = response as Json;
  if (typeof record.exit_code === "number") return record.exit_code !== 0;
  if (typeof record.exitCode === "number") return record.exitCode !== 0;
  if (typeof record.isError === "boolean") return record.isError;
  if (typeof record.success === "boolean") return !record.success;
  return null;
}

const hookOutput = (hookEventName: string, additionalContext: string) =>
  json({ hookSpecificOutput: { hookEventName, additionalContext } });

const CONTEXT_EVENTS: Record<string, string> = {
  "session-start": "SessionStart",
  prompt: "UserPromptSubmit",
  "subagent-start": "SubagentStart",
};

function sharedHandle(
  context: PluginContext,
  event: string,
  input: Json,
  isFailure: (input: Json, event: string) => boolean | null,
): Promise<HookOutput> | HookOutput {
  const session = {
    sessionId: str(input.session_id) || UNKNOWN_SESSION,
    cwd: str(input.cwd) || process.cwd(),
  };
  switch (event) {
    case "session-start":
      return onSessionStart(context, { ...session, source: str(input.source) });
    case "prompt":
      return onPrompt(context, { ...session, prompt: str(input.prompt) });
    case "tool":
    case "tool-failure":
      return onTool(context, {
        ...session,
        tool: str(input.tool_name),
        input: input.tool_input,
        response: input.tool_response,
        error: input.error,
        failed: isFailure(input, event),
        subagent: Boolean(input.agent_id),
      });
    case "stop":
      return onStop(context, { ...session, message: str(input.last_assistant_message) }).then(
        () => ({}),
      );
    case "compact":
      return onFlush(context, session).then(() => ({}));
    case "session-end":
      return onFlush(context, { ...session, message: str(input.last_assistant_message) }).then(
        () => ({}),
      );
    case "subagent-start":
      return onSubagentStart(context, { ...session, agentType: str(input.agent_type) });
    case "subagent-stop":
      return onSubagentStop(context, {
        ...session,
        agentType: str(input.agent_type),
        message: str(input.last_assistant_message),
      }).then(() => ({}));
    default:
      return {};
  }
}

const claudeCode: HostAdapter = {
  handle: async (context, event, input) =>
    sharedHandle(context, event, input, (_input, name) => name === "tool-failure"),
  render: (event, { context }) => {
    const name = CONTEXT_EVENTS[event];
    return context && name ? hookOutput(name, context) : "";
  },
};

const codex: HostAdapter = {
  handle: async (context, event, input) =>
    sharedHandle(context, event, input, (body) => inferFailed(body.tool_response)),
  render: claudeCode.render,
};

// ── Cursor: its own field names, and no way to add context to a prompt ─────────────────────────

const cursor: HostAdapter = {
  deliversOnTool: true,
  handle: async (context, event, input) => {
    const session = {
      sessionId: str(input.session_id) || str(input.conversation_id) || UNKNOWN_SESSION,
      cwd:
        (input.workspace_roots as string[] | undefined)?.[0] ??
        process.env.CURSOR_PROJECT_DIR ??
        process.cwd(),
    };
    switch (event) {
      case "sessionStart":
        return onSessionStart(context, session);
      case "beforeSubmitPrompt":
        return onPrompt(context, { ...session, prompt: str(input.prompt) });
      case "postToolUse":
      case "postToolUseFailure":
        return onTool(context, {
          ...session,
          tool: str(input.tool_name),
          input: input.tool_input,
          response: input.tool_output,
          error: input.error_message,
          failed: event === "postToolUseFailure",
        });
      case "afterAgentResponse":
        await onAssistant(context, { ...session, message: str(input.text) });
        return {};
      case "stop":
        await onStop(context, session);
        return {};
      case "preCompact":
      case "sessionEnd":
        await onFlush(context, session);
        return {};
      default:
        return {};
    }
  },
  render: (event, { context }) => {
    if (event === "beforeSubmitPrompt") return json({ continue: true });
    return context ? json({ additional_context: context }) : "";
  },
};

// ── Kimi: session start can't add context, and a prompt's context is plain text ────────────────

const TRANSCRIPT_TAIL_BYTES = 512 * 1024;

function readTail(path: string): string {
  const file = openSync(path, "r");
  try {
    const { size } = fstatSync(file);
    const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    readSync(file, buffer, 0, length, size - length);
    return buffer.toString("utf8");
  } finally {
    closeSync(file);
  }
}

/** Kimi's Stop hook carries no answer, so it comes from the session's own log. */
export function kimiLastAnswer(sessionId: string): string {
  const home = process.env.KIMI_CODE_HOME?.trim() || join(homedir(), ".kimi-code");
  try {
    let sessionDir = "";
    for (const line of readFileSync(join(home, "session_index.jsonl"), "utf8").split("\n")) {
      if (!line.includes(sessionId)) continue;
      const row = JSON.parse(line) as Json;
      if (row.sessionId === sessionId) sessionDir = str(row.sessionDir);
    }
    if (!sessionDir) return "";
    let answer = "";
    let step = "";
    let text = "";
    for (const line of readTail(join(sessionDir, "agents", "main", "wire.jsonl")).split("\n")) {
      if (!line.includes("context.append_loop_event")) continue;
      let row: Json;
      try {
        row = JSON.parse(line) as Json;
      } catch {
        continue;
      }
      const event = (row.event ?? {}) as Json;
      if (event.type === "step.begin") {
        step = str(event.uuid);
        text = "";
      } else if (event.type === "content.part" && event.stepUuid === step) {
        const part = (event.part ?? {}) as Json;
        if (part.type === "text") text += str(part.text);
      } else if (event.type === "step.end" && text && event.finishReason !== "error") {
        answer = text;
      }
    }
    return answer.trim();
  } catch {
    return "";
  }
}

/** Kimi sends a prompt as typed parts, not a string. */
function partsText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) => (part && typeof part === "object" ? str((part as Json).text) : ""))
    .filter(Boolean)
    .join("\n");
}

const kimi: HostAdapter = {
  quietStart: true,
  handle: async (context, event, input) => {
    const session = {
      sessionId: str(input.session_id) || UNKNOWN_SESSION,
      cwd: str(input.cwd) || process.cwd(),
    };
    switch (event) {
      case "SessionStart":
        await onSessionStart(context, session);
        return {};
      case "UserPromptSubmit":
        return onPrompt(context, { ...session, prompt: partsText(input.prompt) });
      case "PostToolUse":
      case "PostToolUseFailure":
        return onTool(context, {
          ...session,
          tool: str(input.tool_name),
          input: input.tool_input,
          response: input.tool_output ?? input.tool_response,
          error: input.error,
          failed: event === "PostToolUseFailure",
        });
      case "Stop":
        await onStop(context, { ...session, message: kimiLastAnswer(session.sessionId) });
        return {};
      case "PreCompact":
      case "SessionEnd":
        await onFlush(context, session);
        return {};
      case "SubagentStart":
        await onSubagentStart(context, { ...session, agentType: str(input.agent_name) });
        return {};
      case "SubagentStop":
        await onSubagentStop(context, {
          ...session,
          agentType: str(input.agent_name),
          message: str(input.response),
        });
        return {};
      default:
        return {};
    }
  },
  render: (event, { context }) => (event === "UserPromptSubmit" && context ? context : ""),
};

// ── Antigravity: no prompt or answer in the hook itself, only a transcript to read ─────────────

/** The latest thing said by each side. The tail can start mid-line, so bad lines are skipped. */
export function antigravityTurn(path: string): { prompt: string; answer: string } {
  const turn = { prompt: "", answer: "" };
  if (!path) return turn;
  let raw: string;
  try {
    raw = readTail(path);
  } catch {
    return turn;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let step: Json;
    try {
      step = JSON.parse(line) as Json;
    } catch {
      continue;
    }
    if (step.status && step.status !== "DONE") continue;
    const content = str(step.content);
    if (step.type === "USER_INPUT") {
      const request = content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
      turn.prompt = (request?.[1] ?? content).trim();
    } else if (step.source === "MODEL" && step.type === "PLANNER_RESPONSE" && content) {
      turn.answer = content.trim();
    }
  }
  return turn;
}

const antigravity: HostAdapter = {
  handle: async (context, event, input) => {
    const session = {
      sessionId: str(input.conversationId) || UNKNOWN_SESSION,
      cwd: (input.workspacePaths as string[] | undefined)?.[0] ?? process.cwd(),
    };
    const transcript = str(input.transcriptPath);
    switch (event) {
      case "SessionStart":
        return onSessionStart(context, session);
      case "PreInvocation": {
        if (input.invocationNum !== 0) return {};
        return onPrompt(context, { ...session, prompt: antigravityTurn(transcript).prompt });
      }
      case "PostToolUse": {
        const call = (input.toolCall ?? {}) as Json;
        return onTool(context, {
          ...session,
          tool: str(call.name),
          input: call.args,
          error: input.error,
          failed: Boolean(input.error),
        });
      }
      case "Stop":
        await onStop(context, { ...session, message: antigravityTurn(transcript).answer });
        return {};
      default:
        return {};
    }
  },
  // These hooks must answer with JSON, even when they have nothing to say.
  render: (event, { context }) => {
    if (event === "SessionStart" || event === "PreInvocation") {
      const steps = context
        ? [
            event === "SessionStart"
              ? { systemMessage: { systemMessage: context } }
              : { ephemeralMessage: context },
          ]
        : [];
      return json({ injectSteps: steps });
    }
    return "{}";
  },
};

// ── A plugin that isn't in JavaScript, calling these same hooks by command ─────────────────────

const plain: HostAdapter = {
  quietStart: true,
  handle: claudeCode.handle,
  render: (_event, { context }) => context ?? "",
};

export const HOST_ADAPTERS: Record<string, HostAdapter> = {
  "claude-code": claudeCode,
  codex,
  cursor,
  kimi,
  antigravity,
  hermes: plain,
};
