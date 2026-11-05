import {
  type IDataObject,
  type IExecuteFunctions,
  type INodeExecutionData,
  type INodeType,
  type INodeTypeDescription,
  NodeConnectionTypes,
  NodeOperationError,
} from "n8n-workflow";
import { TURN_KIND } from "../../lib/chat-memory.js";
import {
  CREDENTIAL,
  clientFor,
  namespaceOptions,
  operationError,
  spaceOptions,
} from "../../lib/client.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const PAGE = 100;
const WILDCARD = "*";
const memory = { resource: ["memory"] };
const file = { resource: ["file"] };

const whoFields = (operation: string[]) => [
  {
    displayName: "User ID",
    name: "userId",
    type: "string" as const,
    default: "",
    description: "Who this is about",
    displayOptions: { show: { ...memory, operation } },
  },
  {
    displayName: "Agent ID",
    name: "agentId",
    type: "string" as const,
    default: "",
    description: "Which agent this belongs to",
    displayOptions: { show: { ...memory, operation } },
  },
  {
    displayName: "Run ID",
    name: "runId",
    type: "string" as const,
    default: "",
    description: "Which session or run this belongs to",
    displayOptions: { show: { ...memory, operation } },
  },
];

export class MemDot implements INodeType {
  description: INodeTypeDescription = {
    displayName: "MemDot",
    name: "memDot",
    icon: { light: "file:memdot.svg", dark: "file:memdot.dark.svg" },
    group: ["transform"],
    version: 1,
    subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
    description: "Long-term memory and encrypted files on Portaldot V3",
    defaults: { name: "MemDot" },
    usableAsTool: true,
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: CREDENTIAL, required: true }],
    properties: [
      {
        displayName: "Resource",
        name: "resource",
        type: "options",
        noDataExpression: true,
        default: "memory",
        options: [
          { name: "Memory", value: "memory" },
          { name: "File", value: "file" },
        ],
      },
      {
        displayName: "Operation",
        name: "operation",
        type: "options",
        noDataExpression: true,
        default: "add",
        displayOptions: { show: memory },
        options: [
          {
            name: "Add",
            value: "add",
            action: "Remember something",
            description: "Remember something",
          },
          {
            name: "Delete",
            value: "delete",
            action: "Forget a memory",
            description: "Forget a memory",
          },
          { name: "Get", value: "get", action: "Read a memory", description: "Read one memory" },
          {
            name: "Get Many",
            value: "getAll",
            action: "List memories",
            description: "List memories, newest first",
          },
          {
            name: "Search",
            value: "search",
            action: "Search memories",
            description: "Find what's been remembered, by meaning and keyword",
          },
          {
            name: "Update",
            value: "update",
            action: "Correct a memory",
            description: "Correct a memory; the old version stays in its history",
          },
        ],
      },
      {
        displayName: "Operation",
        name: "operation",
        type: "options",
        noDataExpression: true,
        default: "upload",
        displayOptions: { show: file },
        options: [
          {
            name: "Delete",
            value: "delete",
            action: "Delete a file",
            description: "Delete a file; its bytes leave the chain within 7 days",
          },
          {
            name: "Download",
            value: "download",
            action: "Download a file",
            description: "Fetch a file and decrypt it here",
          },
          {
            name: "Get Many",
            value: "getAll",
            action: "List files",
            description: "List files, with names decrypted here",
          },
          {
            name: "Upload",
            value: "upload",
            action: "Upload a file",
            description: "Encrypt a file here and store it on Portaldot V3",
          },
          {
            name: "Verify",
            value: "verify",
            action: "Verify a file",
            description: "Check a file against the chain from here",
          },
        ],
      },

      {
        displayName: "Namespace Name or ID",
        name: "namespaceId",
        type: "options",
        typeOptions: { loadOptionsMethod: "getNamespaces" },
        default: "",
        description:
          'Where memories live. Blank uses your default namespace. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
        displayOptions: { show: { ...memory, operation: ["add", "search", "getAll"] } },
      },
      {
        displayName: "Text",
        name: "text",
        type: "string",
        typeOptions: { rows: 4 },
        default: "",
        required: true,
        description: "What to remember: a fact or a whole conversation",
        displayOptions: { show: { ...memory, operation: ["add", "update"] } },
      },
      {
        displayName: "Query",
        name: "query",
        type: "string",
        default: "",
        required: true,
        description: "What to look for, in plain words",
        displayOptions: { show: { ...memory, operation: ["search"] } },
      },
      ...whoFields(["add", "search", "getAll"]),
      {
        displayName: "Across Everyone",
        name: "everyone",
        type: "boolean",
        default: false,
        description:
          "Whether to look through every person's memories in this namespace. Without this, leaving the IDs empty is an error, so a mapping that comes back empty can't reach other people's.",
        displayOptions: { show: { ...memory, operation: ["search", "getAll"] } },
      },
      {
        displayName: "Memory ID",
        name: "memoryId",
        type: "string",
        default: "",
        required: true,
        displayOptions: { show: { ...memory, operation: ["get", "update", "delete"] } },
      },
      {
        displayName: "Return All",
        name: "returnAll",
        type: "boolean",
        default: false,
        description: "Whether to return all results or only up to a given limit",
        displayOptions: { show: { operation: ["getAll"] } },
      },
      {
        displayName: "Limit",
        name: "limit",
        type: "number",
        typeOptions: { minValue: 1, maxValue: MAX_LIMIT },
        default: DEFAULT_LIMIT,
        description: "Max number of results to return",
        displayOptions: { show: { operation: ["search"] } },
      },
      {
        displayName: "Limit",
        name: "limit",
        type: "number",
        typeOptions: { minValue: 1, maxValue: MAX_LIMIT },
        default: DEFAULT_LIMIT,
        description: "Max number of results to return",
        displayOptions: { show: { operation: ["getAll"], returnAll: [false] } },
      },
      {
        displayName: "Options",
        name: "addOptions",
        type: "collection",
        placeholder: "Add Option",
        default: {},
        displayOptions: { show: { ...memory, operation: ["add"] } },
        options: [
          {
            displayName: "Distill With a Model",
            name: "infer",
            type: "boolean",
            default: true,
            description:
              "Whether to keep the facts a model finds in the text, rather than the text as written",
          },
          {
            displayName: "Expires",
            name: "expirationDate",
            type: "dateTime",
            default: "",
            description: "When it stops counting",
          },
          {
            displayName: "Metadata",
            name: "metadata",
            type: "json",
            default: "{}",
            description: "Anything to keep with it, as a JSON object",
          },
        ],
      },
      {
        displayName: "Options",
        name: "searchOptions",
        type: "collection",
        placeholder: "Add Option",
        default: {},
        displayOptions: { show: { ...memory, operation: ["search"] } },
        options: [
          {
            displayName: "Filters",
            name: "filters",
            type: "json",
            default: "{}",
            description: 'Narrows it further, for example {"AND":[{"categories":{"in":["work"]}}]}',
          },
          {
            displayName: "Match",
            name: "mode",
            type: "options",
            default: "hybrid",
            options: [
              { name: "Meaning and Keywords", value: "hybrid" },
              { name: "Meaning Only", value: "semantic" },
              { name: "Keywords Only", value: "keyword" },
            ],
          },
          {
            displayName: "Minimum Similarity",
            name: "threshold",
            type: "number",
            typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 2 },
            default: 0.1,
          },
          {
            displayName: "Rerank With a Model",
            name: "rerank",
            type: "boolean",
            default: false,
            description: "Whether a model should put the best first",
          },
        ],
      },

      {
        displayName: "Space Name or ID",
        name: "spaceId",
        type: "options",
        typeOptions: { loadOptionsMethod: "getSpaces" },
        default: "",
        description:
          'Where the file lives. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
        displayOptions: { show: { ...file, operation: ["upload", "getAll"] } },
      },
      {
        displayName: "Input Binary Field",
        name: "binaryPropertyName",
        type: "string",
        default: "data",
        required: true,
        description: "Which binary field holds the file",
        displayOptions: { show: { ...file, operation: ["upload"] } },
      },
      {
        displayName: "File Name",
        name: "fileName",
        type: "string",
        default: "",
        description: "What to call it. Blank uses the name it came with.",
        displayOptions: { show: { ...file, operation: ["upload"] } },
      },
      {
        displayName: "File ID",
        name: "fileId",
        type: "string",
        default: "",
        required: true,
        displayOptions: { show: { ...file, operation: ["download", "verify", "delete"] } },
      },
      {
        displayName: "Output Binary Field",
        name: "outputField",
        type: "string",
        default: "data",
        required: true,
        description: "Which binary field to put the file in",
        displayOptions: { show: { ...file, operation: ["download"] } },
      },
    ],
  };

  methods = { loadOptions: { getNamespaces: namespaceOptions, getSpaces: spaceOptions } };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const output: INodeExecutionData[] = [];
    const { memdot, holdsKeys } = await clientFor(this);

    const parameter = <T>(name: string, i: number, fallback?: T) =>
      this.getNodeParameter(name, i, fallback) as T;
    // An expression that finds nothing comes back undefined, which isn't anyone's id.
    const textOf = (name: string, i: number) => {
      const value = parameter<unknown>(name, i, "");
      return value === undefined || value === null ? "" : String(value).trim();
    };
    const push = (i: number, json: IDataObject) => output.push({ json, pairedItem: { item: i } });
    const jsonOption = (value: unknown, label: string, i: number) => {
      if (value === undefined || value === "" || value === "{}") return undefined;
      if (typeof value !== "string") return value as Record<string, unknown>;
      try {
        return JSON.parse(value) as Record<string, unknown>;
      } catch {
        throw new NodeOperationError(this.getNode(), `${label} isn't valid JSON.`, {
          itemIndex: i,
        });
      }
    };
    const scope = (i: number) => {
      const userId = textOf("userId", i);
      const agentId = textOf("agentId", i);
      const runId = textOf("runId", i);
      return {
        ...(userId ? { userId } : {}),
        ...(agentId ? { agentId } : {}),
        ...(runId ? { runId } : {}),
      };
    };
    const where = (i: number) => {
      const namespaceId = textOf("namespaceId", i);
      return namespaceId ? { namespaceId } : {};
    };
    /** The filters for a read: an empty scope means everyone only if that was asked for. */
    const readFilters = (i: number, extra: Record<string, unknown>[] = []) => {
      const { userId, agentId, runId } = scope(i);
      const parts: Record<string, unknown>[] = [
        ...(userId ? [{ user_id: { eq: userId } }] : []),
        ...(agentId ? [{ agent_id: { eq: agentId } }] : []),
        ...(runId ? [{ run_id: { eq: runId } }] : []),
      ];
      if (parts.length === 0) {
        if (!parameter<boolean>("everyone", i, false)) {
          throw new NodeOperationError(
            this.getNode(),
            "No User ID, Agent ID or Run ID, so this would search everyone's memories. If a mapping came back empty, fix that. If you do mean everyone, turn on Across Everyone.",
            { itemIndex: i },
          );
        }
        // Stored chat turns aren't memories about anyone.
        parts.push({ NOT: { "metadata.kind": TURN_KIND } });
      }
      const all = [...parts, ...extra];
      return { filters: { AND: all } };
    };
    const needKeys = (i: number) => {
      if (holdsKeys) return;
      throw new NodeOperationError(
        this.getNode(),
        "Files are encrypted here in n8n, which takes a connected agent's identity. Get one with memdot login --print-env --label n8n and add it to the MemDot credential.",
        { itemIndex: i },
      );
    };

    try {
      for (let i = 0; i < items.length; i += 1) {
        try {
          const resource = parameter<string>("resource", i);
          const operation = parameter<string>("operation", i);

          if (resource === "memory") {
            if (operation === "add") {
              const options = parameter<IDataObject>("addOptions", i, {});
              const metadata = jsonOption(options.metadata, "Metadata", i);
              const who = scope(i);
              if ([who.userId, who.agentId, who.runId].includes(WILDCARD)) {
                throw new NodeOperationError(
                  this.getNode(),
                  `"${WILDCARD}" means everyone in a filter, so it can't be someone's ID.`,
                  { itemIndex: i },
                );
              }
              if (!who.userId && !who.agentId && !who.runId) {
                throw new NodeOperationError(
                  this.getNode(),
                  "Give at least one of User ID, Agent ID or Run ID, so the memory has someone to belong to.",
                  { itemIndex: i },
                );
              }
              const added = await memdot.memories.add(textOf("text", i), {
                ...who,
                ...where(i),
                infer: options.infer !== false,
                ...(metadata ? { metadata } : {}),
                ...(options.expirationDate
                  ? { expirationDate: String(options.expirationDate) }
                  : {}),
              });
              push(i, {
                event_id: added.eventId,
                status: added.status,
                namespace_id: added.namespaceId,
                results: added.results,
                duplicates: added.duplicates,
                note: added.note,
              } as IDataObject);
            } else if (operation === "search") {
              const options = parameter<IDataObject>("searchOptions", i, {});
              const extra = jsonOption(options.filters, "Filters", i);
              const found = await memdot.memories.search(textOf("query", i), {
                ...where(i),
                topK: parameter<number>("limit", i, DEFAULT_LIMIT),
                ...readFilters(i, extra ? [extra] : []),
                ...(options.mode
                  ? { mode: options.mode as "hybrid" | "semantic" | "keyword" }
                  : {}),
                ...(options.threshold !== undefined
                  ? { threshold: Number(options.threshold) }
                  : {}),
                ...(options.rerank ? { rerank: true } : {}),
              });
              for (const hit of found) push(i, hit as unknown as IDataObject);
            } else if (operation === "getAll") {
              const returnAll = parameter<boolean>("returnAll", i, false);
              const limit = returnAll
                ? Number.POSITIVE_INFINITY
                : parameter<number>("limit", i, DEFAULT_LIMIT);
              const filters = readFilters(i);
              let cursor: string | undefined;
              let sent = 0;
              do {
                const page = await memdot.memories.list({
                  ...where(i),
                  ...filters,
                  pageSize: Math.min(PAGE, limit - sent),
                  ...(cursor ? { cursor } : {}),
                });
                for (const row of page.results) push(i, row as unknown as IDataObject);
                sent += page.results.length;
                cursor = page.nextCursor ?? undefined;
              } while (cursor && sent < limit);
            } else if (operation === "get") {
              push(i, (await memdot.memories.get(textOf("memoryId", i))) as unknown as IDataObject);
            } else if (operation === "update") {
              const id = textOf("memoryId", i);
              await memdot.memories.update(id, { text: textOf("text", i) });
              push(i, (await memdot.memories.get(id)) as unknown as IDataObject);
            } else if (operation === "delete") {
              const id = textOf("memoryId", i);
              await memdot.memories.delete(id);
              push(i, { id, deleted: true });
            }
            continue;
          }

          if (operation === "upload") {
            needKeys(i);
            const field = textOf("binaryPropertyName", i);
            const binary = this.helpers.assertBinaryData(i, field);
            const data = await this.helpers.getBinaryDataBuffer(i, field);
            const spaceId = textOf("spaceId", i);
            if (!spaceId) {
              throw new NodeOperationError(this.getNode(), "Choose a space to store it in.", {
                itemIndex: i,
              });
            }
            const { file: stored, job } = await memdot.files.put(new Uint8Array(data), {
              spaceId,
              name: textOf("fileName", i) || binary.fileName || "file",
              ...(binary.mimeType ? { mime: binary.mimeType } : {}),
            });
            push(i, {
              id: stored.id,
              name: stored.name,
              status: job.status,
              job_id: job.id,
              tx_hash: job.txHash,
              block: job.block,
            } as IDataObject);
          } else if (operation === "download") {
            needKeys(i);
            const { data, name, mime } = await memdot.files.get(textOf("fileId", i));
            const field = textOf("outputField", i);
            output.push({
              json: { name, mime, size: data.length },
              binary: {
                [field]: await this.helpers.prepareBinaryData(Buffer.from(data), name, mime),
              },
              pairedItem: { item: i },
            });
          } else if (operation === "getAll") {
            const spaceId = textOf("spaceId", i);
            const returnAll = parameter<boolean>("returnAll", i, false);
            const limit = returnAll
              ? Number.POSITIVE_INFINITY
              : parameter<number>("limit", i, DEFAULT_LIMIT);
            let cursor: string | undefined;
            let sent = 0;
            do {
              const page = await memdot.files.list({
                ...(spaceId ? { spaceId } : {}),
                limit: Math.min(PAGE, limit - sent),
                ...(cursor ? { cursor } : {}),
              });
              for (const row of page.items) push(i, row as unknown as IDataObject);
              sent += page.items.length;
              cursor = page.nextCursor ?? undefined;
            } while (cursor && sent < limit);
          } else if (operation === "verify") {
            push(i, (await memdot.files.verify(textOf("fileId", i))) as unknown as IDataObject);
          } else if (operation === "delete") {
            const id = textOf("fileId", i);
            await memdot.files.delete(id);
            push(i, { id, deleted: true });
          }
        } catch (error) {
          const failure =
            error instanceof NodeOperationError ? error : operationError(this, error, i);
          if (!this.continueOnFail()) throw failure;
          push(i, { error: failure.message });
        }
      }
    } finally {
      await memdot.close();
    }
    return [output];
  }
}
