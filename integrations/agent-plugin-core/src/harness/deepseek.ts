import { jsonSchema, TOOLS } from "../tools.js";
import { createRuntime, messageText } from "./runtime.js";

const HOST = "deepseek";

interface Assembly {
  contexts: { name: string; text: string }[];
}
interface HarnessSession {
  id?: string;
  cwd?: string;
  deriveMessages?: () => { role?: string; content?: unknown }[];
}
interface HarnessContext {
  tools: { register(tool: unknown): () => void };
  on(event: string, handler: (...args: never[]) => unknown): void;
}

export const name = "memdot";
/** Holds this plugin until the harness has these ready. */
export const inject = ["tools", "systemPrompt"];

export function apply(ctx: HarnessContext): void {
  const runtime = createRuntime(HOST, import.meta.url);
  const cwd = process.cwd();
  /** The prompt is assembled per request, so what was recalled has to go in every time. */
  const recalled = new Map<string, string>();
  const started = new Set<string>();
  const idOf = (session: HarnessSession | undefined) => session?.id ?? "deepseek-session";

  for (const spec of TOOLS) {
    ctx.tools.register({
      name: spec.name,
      description: spec.description,
      parameters: jsonSchema(spec),
      output: {
        schema: { type: "string" },
        render: (_args: unknown, value: string) => [{ type: "text", text: value }],
      },
      execute: (args: Record<string, unknown>) => spec.run(HOST, args, cwd),
    });
  }

  ctx.on(
    "system-prompt/assemble",
    async (
      _input: unknown,
      context: { agent?: { session?: HarnessSession } },
      next: () => Promise<Assembly>,
    ) => {
      const assembly = await next();
      const session = context.agent?.session;
      const messages = session?.deriveMessages?.() ?? [];
      const prompt = [...messages].reverse().find((message) => message.role === "user");
      const sessionId = idOf(session);
      if (prompt && !started.has(sessionId)) {
        started.add(sessionId);
        await runtime.start({ sessionId, cwd });
        const found = await runtime.prompt({ sessionId, cwd, prompt: messageText(prompt) });
        if (found.context) recalled.set(sessionId, found.context);
      }
      const text = recalled.get(sessionId);
      return text
        ? { ...assembly, contexts: [...assembly.contexts, { name: "memdot:recall", text }] }
        : assembly;
    },
  );

  ctx.on(
    "session/event",
    async (
      session: HarnessSession,
      event: { type: string; data?: { message?: unknown; reason?: { kind?: string } } },
    ) => {
      const sessionId = idOf(session);
      if (event.type === "assistant/message") {
        await runtime.assistant({ sessionId, cwd, message: messageText(event.data?.message) });
      } else if (event.type === "turn/end" && event.data?.reason?.kind === "completed") {
        await runtime.stop({ sessionId, cwd });
      }
    },
  );
}
