import { jsonSchema, TOOLS } from "../tools.js";
import { createRuntime, lastAssistantText } from "./runtime.js";

const HOST = "openclaw";
const DEFAULT_SESSION = "openclaw-main";

interface HookContext {
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
}
interface OpenClawApi {
  on(hook: string, handler: (event: never, ctx: HookContext) => unknown): void;
  registerTool(tool: unknown, options?: unknown): void;
}

export default {
  id: "memdot",
  name: "MemDot",
  description:
    "Long-term memory for coding agents: encrypted on your device, stored on Portaldot V3, and yours to move or revoke.",
  register(api: OpenClawApi): void {
    const runtime = createRuntime(HOST, import.meta.url);
    const session = (ctx: HookContext) => ({
      sessionId: ctx.sessionKey ?? ctx.sessionId ?? DEFAULT_SESSION,
      cwd: ctx.workspaceDir ?? process.cwd(),
    });

    for (const spec of TOOLS) {
      api.registerTool(
        (tool: HookContext) => ({
          name: spec.name,
          description: spec.description,
          parameters: jsonSchema(spec),
          execute: async (_id: string, args: Record<string, unknown>) => ({
            content: [{ type: "text", text: await spec.run(HOST, args, session(tool).cwd) }],
            details: {},
          }),
        }),
        { name: spec.name },
      );
    }

    api.on("session_start", async (_event, ctx) => {
      await runtime.start(session(ctx));
    });

    api.on(
      "before_prompt_build",
      async (event: { prompt?: string; currentUserMessage?: string }, ctx) => {
        const prompt = event.currentUserMessage ?? event.prompt ?? "";
        const { context } = await runtime.prompt({ ...session(ctx), prompt });
        return context ? { prependContext: context } : undefined;
      },
    );

    api.on(
      "after_tool_call",
      async (
        event: { toolName?: string; params?: unknown; result?: unknown; error?: unknown },
        ctx,
      ) => {
        await runtime.tool({
          ...session(ctx),
          tool: event.toolName ?? "unknown",
          input: event.params,
          response: event.result,
          error: event.error,
          failed: event.error ? true : null,
        });
      },
    );

    api.on("agent_end", async (event: { messages?: unknown[] }, ctx) => {
      await runtime.stop({ ...session(ctx), message: lastAssistantText(event.messages ?? []) });
    });
    api.on("before_compaction", async (_event, ctx) => {
      await runtime.flush(session(ctx));
    });
    api.on("session_end", async (_event, ctx) => {
      await runtime.flush(session(ctx));
    });
  },
};
