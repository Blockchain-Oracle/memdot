import { jsonSchema, TOOLS } from "../tools.js";
import { createRuntime, lastAssistantText } from "./runtime.js";

const HOST = "pi";

interface PiContext {
  cwd: string;
  sessionManager: { getSessionId(): string };
}
interface PiApi {
  on(event: string, handler: (event: never, ctx: PiContext) => unknown): void;
  registerTool(tool: unknown): void;
}

/** Pi loads this as an extension. Tools go in now; anything that runs waits for a session. */
export default function memdot(pi: PiApi): void {
  const runtime = createRuntime(HOST, import.meta.url);
  const session = (ctx: PiContext) => ({
    sessionId: ctx.sessionManager.getSessionId(),
    cwd: ctx.cwd,
  });
  /** Pi rebuilds the system prompt for each run, so what was recalled has to go in every time. */
  let recalled: string | undefined;

  for (const spec of TOOLS) {
    pi.registerTool({
      name: spec.name,
      label: spec.name.replace("_", " "),
      description: spec.description,
      parameters: jsonSchema(spec),
      execute: async (
        _id: string,
        args: Record<string, unknown>,
        _signal: unknown,
        _update: unknown,
        ctx: PiContext,
      ) => ({
        content: [{ type: "text", text: await spec.run(HOST, args, ctx.cwd) }],
        details: {},
      }),
    });
  }

  pi.on(
    "session_start",
    runtime.guard("start", async (event: { reason?: string }, ctx: PiContext) => {
      const { context } = await runtime.start({
        ...session(ctx),
        source: event.reason === "resume" ? "resume" : "startup",
      });
      recalled = context;
    }),
  );

  pi.on(
    "before_agent_start",
    runtime.guard(
      "prompt",
      async (event: { prompt?: string; systemPrompt: string }, ctx: PiContext) => {
        const { context } = await runtime.prompt({ ...session(ctx), prompt: event.prompt ?? "" });
        if (context) recalled = context;
        return recalled ? { systemPrompt: `${event.systemPrompt}\n\n${recalled}` } : undefined;
      },
    ),
  );

  pi.on(
    "tool_result",
    runtime.guard(
      "tool",
      async (
        event: { toolName: string; input: unknown; content?: unknown; isError?: boolean },
        ctx: PiContext,
      ) => {
        await runtime.tool({
          ...session(ctx),
          tool: event.toolName,
          input: event.input,
          response: event.content,
          failed: event.isError ?? null,
        });
      },
    ),
  );

  pi.on(
    "agent_end",
    runtime.guard("end", async (event: { messages?: unknown[] }, ctx: PiContext) => {
      await runtime.stop({ ...session(ctx), message: lastAssistantText(event.messages ?? []) });
    }),
  );
  const flush = runtime.guard("flush", async (_event: unknown, ctx: PiContext) => {
    await runtime.flush(session(ctx));
  });
  pi.on("session_before_compact", flush);
  pi.on("session_shutdown", flush);
}
