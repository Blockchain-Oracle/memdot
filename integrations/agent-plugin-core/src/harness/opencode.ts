import { z } from "zod";
import { TOOLS, type ToolParameter } from "../tools.js";
import { createRuntime, lastAssistantText, readSkills } from "./runtime.js";

const HOST = "opencode";

function zodFor(parameter: ToolParameter): z.ZodType {
  const base = parameter.enum
    ? z.enum(parameter.enum as [string, ...string[]])
    : parameter.type === "integer"
      ? z.number().int()
      : z.string();
  const described = base.describe(parameter.description);
  return parameter.required ? described : described.optional();
}

interface OpenCodeInput {
  directory: string;
  worktree?: string;
  client?: {
    session?: {
      messages?: (options: { path: { id: string } }) => Promise<{ data?: unknown[] }>;
    };
  };
}

interface OpenCodeMessage {
  info?: { role?: string };
  parts?: { type?: string; text?: string }[];
}

/** OpenCode loads this file directly. It has no manifest: this function is the whole plugin. */
export const MemDotPlugin = async ({ directory, worktree, client }: OpenCodeInput) => {
  const runtime = createRuntime(HOST, import.meta.url);
  const cwd = worktree && worktree !== "/" ? worktree : directory;
  await runtime.installLauncher().catch(() => undefined);
  /** What's been recalled, by session. The system prompt is rebuilt per request, so it stays here. */
  const recalled = new Map<string, string>();
  const started = new Set<string>();

  const begin = async (sessionId: string) => {
    if (started.has(sessionId)) return;
    started.add(sessionId);
    const { context } = await runtime.start({ sessionId, cwd });
    if (context) recalled.set(sessionId, context);
  };

  const lastAnswer = async (sessionId: string): Promise<string> => {
    const messages = await client?.session?.messages?.({ path: { id: sessionId } });
    const shaped = ((messages?.data ?? []) as OpenCodeMessage[]).map((message) => ({
      role: message.info?.role,
      content: message.parts ?? [],
    }));
    return lastAssistantText(shaped);
  };

  return {
    tool: Object.fromEntries(
      TOOLS.map((spec) => [
        spec.name,
        {
          description: spec.description,
          args: Object.fromEntries(
            Object.entries(spec.parameters).map(([name, parameter]) => [name, zodFor(parameter)]),
          ),
          execute: (args: Record<string, unknown>) => spec.run(HOST, args, cwd),
        },
      ]),
    ),

    config: async (config: {
      mcp?: Record<string, unknown>;
      command?: Record<string, unknown>;
    }) => {
      config.mcp = {
        memdot: { type: "local", command: ["node", runtime.script, "mcp", HOST], enabled: true },
        ...config.mcp,
      };
      const commands = Object.fromEntries(
        readSkills(runtime.skillsDir).map((skill) => [
          skill.name,
          { description: skill.description, template: skill.body },
        ]),
      );
      config.command = { ...commands, ...config.command };
    },

    "chat.message": async (
      input: { sessionID: string },
      output: { parts: { type?: string; text?: string }[] },
    ) => {
      await begin(input.sessionID);
      const prompt = output.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text ?? "")
        .join("\n");
      const { context } = await runtime.prompt({ sessionId: input.sessionID, cwd, prompt });
      if (context) recalled.set(input.sessionID, context);
    },

    "experimental.chat.system.transform": async (
      input: { sessionID?: string },
      output: { system: string[] },
    ) => {
      const context = input.sessionID ? recalled.get(input.sessionID) : undefined;
      if (context) output.system.push(context);
    },

    "tool.execute.after": async (
      input: { tool: string; sessionID: string; args?: unknown },
      output: { output?: unknown; metadata?: unknown },
    ) => {
      await runtime.tool({
        sessionId: input.sessionID,
        cwd,
        tool: input.tool,
        input: input.args,
        response: output.output,
        failed: null,
      });
    },

    "experimental.session.compacting": async (input: { sessionID: string }) => {
      await runtime.flush({ sessionId: input.sessionID, cwd });
    },

    event: async ({ event }: { event: { type: string; properties?: Record<string, unknown> } }) => {
      const info = event.properties?.info as { id?: string } | undefined;
      const sessionId = (event.properties?.sessionID as string | undefined) ?? info?.id;
      if (!sessionId) return;
      if (event.type === "session.created") await begin(sessionId);
      if (event.type === "session.idle") {
        await runtime.stop({ sessionId, cwd, message: await lastAnswer(sessionId) });
      }
      if (event.type === "session.deleted") await runtime.flush({ sessionId, cwd });
    },
  };
};
