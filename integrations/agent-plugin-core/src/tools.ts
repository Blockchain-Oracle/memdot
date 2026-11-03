import { forgetIds, getText, listText, rememberText, searchText, statusReport } from "./control.js";
import { SEARCH_SCOPES } from "./settings.js";

export interface ToolParameter {
  type: "string" | "integer" | "array";
  description: string;
  required?: boolean;
  enum?: readonly string[];
}

/** One tool, for hosts that take tools in code. Each host wraps these in its own schema style. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, ToolParameter>;
  run(host: string, args: Record<string, unknown>, cwd: string): Promise<string>;
}

const SCOPE: ToolParameter = {
  type: "string",
  description:
    "repo: this repository, plus the user's own preferences. mine: everything of the user's. all: the whole namespace.",
  enum: SEARCH_SCOPES,
};

export const TOOLS: ToolSpec[] = [
  {
    name: "memdot_search",
    description:
      "Search what's been remembered from earlier sessions, by meaning. Use it before relearning how something works.",
    parameters: {
      query: { type: "string", description: "What to look for.", required: true },
      scope: SCOPE,
      top_k: { type: "integer", description: "How many results to return." },
    },
    run: (host, args, cwd) =>
      searchText(host, args.query as string, {
        scope: args.scope as string | undefined,
        topK: args.top_k as number | undefined,
        cwd,
      }),
  },
  {
    name: "memdot_remember",
    description:
      "Save one durable fact for later sessions, exactly as written. It has to make sense on its own, without this conversation.",
    parameters: { text: { type: "string", description: "The fact.", required: true } },
    run: (host, args, cwd) => rememberText(host, args.text as string, cwd),
  },
  {
    name: "memdot_list",
    description: "List what's been remembered here, newest first.",
    parameters: {
      scope: SCOPE,
      limit: { type: "integer", description: "How many to return." },
    },
    run: (host, args, cwd) =>
      listText(host, {
        scope: args.scope as string | undefined,
        limit: args.limit as number | undefined,
        cwd,
      }),
  },
  {
    name: "memdot_get",
    description: "Read one memory in full, by its id.",
    parameters: { id: { type: "string", description: "The memory's id.", required: true } },
    run: (host, args) => getText(host, args.id as string),
  },
  {
    name: "memdot_forget",
    description:
      "Permanently forget one memory. This can't be undone, so only use it after the user has clearly said to.",
    parameters: { id: { type: "string", description: "The memory's id.", required: true } },
    run: (host, args) => forgetIds(host, [args.id as string]),
  },
  {
    name: "memdot_status",
    description: "Whether memory is connected and saving here, and anything stopping it.",
    parameters: {},
    run: async (host, _args, cwd) => JSON.stringify(await statusReport(host, cwd), null, 2),
  },
];

/** The same parameters as JSON Schema, which most hosts read directly. */
export function jsonSchema(tool: ToolSpec) {
  const properties = Object.fromEntries(
    Object.entries(tool.parameters).map(([name, parameter]) => [
      name,
      {
        type: parameter.type,
        description: parameter.description,
        ...(parameter.enum ? { enum: parameter.enum } : {}),
      },
    ]),
  );
  const required = Object.entries(tool.parameters)
    .filter(([, parameter]) => parameter.required)
    .map(([name]) => name);
  return { type: "object", properties, required, additionalProperties: false };
}
