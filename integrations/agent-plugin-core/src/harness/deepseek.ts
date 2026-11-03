import { jsonSchema, TOOLS } from "../tools.js";
import { createRuntime, messageText } from "./runtime.js";

const HOST = "deepseek";

interface Assembly {
  contexts: { name: string; text: string }[];
}
interface HarnessSession {
  id?: string;
  deriveMessages?: () => { role?: string; content?: unknown; source?: { kind?: string } }[];
}
interface HarnessContext {
  tools: { register(tool: unknown): () => void };
  on(event: string, handler: (...args: never[]) => unknown): void;
}

export const name = "memdot";
/** Holds this plugin until the harness has these ready. */
export const inject = ["tools", "systemPrompt"];

export function apply(ctx: HarnessContext): void {
  const runtime = createRuntime(HOST, import.meta.url, { quietStart: true });
  const cwd = process.cwd();
  /** The prompt is assembled per request, so what was recalled has to go in every time. */
  const recalled = new Map<string, string>();
  const started = new Set<string>();
  const lastPrompt = new Map<string, string>();
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

  /** Each request is the one place every new prompt passes through, so they're noted here. */
  const notePrompt = runtime.guard("prompt", async (session: HarnessSession | undefined) => {
    const sessionId = idOf(session);
    const messages = session?.deriveMessages?.() ?? [];
    const latest = [...messages]
      .reverse()
      .find((message) => message.role === "user" && message.source?.kind !== "system");
    const prompt = latest ? messageText(latest) : "";
    if (!prompt || lastPrompt.get(sessionId) === prompt) return;
    lastPrompt.set(sessionId, prompt);
    if (!started.has(sessionId)) {
      started.add(sessionId);
      await runtime.start({ sessionId, cwd });
    }
    const found = await runtime.prompt({ sessionId, cwd, prompt });
    if (found.context) recalled.set(sessionId, found.context);
  });

  ctx.on(
    "system-prompt/assemble",
    async (
      _input: unknown,
      context: { agent?: { session?: HarnessSession } },
      next: () => Promise<Assembly>,
    ) => {
      // A failure in the harness's own assembly is the harness's to report. Only ours is contained.
      const assembly = await next();
      const session = context.agent?.session;
      await notePrompt(session);
      const text = recalled.get(idOf(session));
      return text
        ? { ...assembly, contexts: [...assembly.contexts, { name: "memdot:recall", text }] }
        : assembly;
    },
  );

  ctx.on(
    "session/event",
    runtime.guard(
      "event",
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
    ),
  );
}
