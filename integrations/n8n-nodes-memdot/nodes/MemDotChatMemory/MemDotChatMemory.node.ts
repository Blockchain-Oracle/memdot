import { supplyMemory } from "@n8n/ai-node-sdk";
import {
  type INodeType,
  type INodeTypeDescription,
  type ISupplyDataFunctions,
  NodeConnectionTypes,
  type SupplyData,
} from "n8n-workflow";
import { MemDotChatMemory as Memory } from "../../lib/chat-memory.js";
import { CREDENTIAL, clientFor, namespaceOptions } from "../../lib/client.js";

const DOCS = "https://github.com/Blockchain-Oracle/memdot/tree/main/integrations/n8n-nodes-memdot";

export class MemDotChatMemory implements INodeType {
  description: INodeTypeDescription = {
    displayName: "MemDot Chat Memory",
    name: "memDotChatMemory",
    icon: { light: "file:memdot.svg", dark: "file:memdot.dark.svg" },
    group: ["transform"],
    version: 1,
    description: "Gives an AI Agent long-term memory, encrypted and on Portaldot V3",
    defaults: { name: "MemDot Chat Memory" },
    codex: {
      categories: ["AI"],
      subcategories: { AI: ["Memory"], Memory: ["Other memories"] },
      resources: { primaryDocumentation: [{ url: DOCS }] },
    },
    inputs: [],
    outputs: [NodeConnectionTypes.AiMemory],
    outputNames: ["Memory"],
    credentials: [{ name: CREDENTIAL, required: true }],
    properties: [
      {
        displayName: "Session ID",
        name: "sessionId",
        type: "string",
        default: "={{ $json.sessionId }}",
        required: true,
        description: "Which conversation this is. Its last turns come back with every message.",
      },
      {
        displayName: "User ID",
        name: "userId",
        type: "string",
        default: "",
        description:
          "Who this is. With one, what's learned here is kept across every session with them. Without one, only this session's turns are kept.",
      },
      {
        displayName: "Search For",
        name: "query",
        type: "string",
        default: "={{ $json.chatInput }}",
        description: "What to look for among what's known about the user: usually the new message",
        displayOptions: { hide: { userId: [""] } },
      },
      {
        displayName: "Turns to Keep in Context",
        name: "windowSize",
        type: "number",
        typeOptions: { minValue: 1, maxValue: 50 },
        default: 10,
        description: "How many of this session's latest turns the agent sees",
      },
      {
        displayName: "Namespace Name or ID",
        name: "namespaceId",
        type: "options",
        typeOptions: { loadOptionsMethod: "getNamespaces" },
        default: "",
        description:
          'Where memories live. Blank uses your default namespace. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
      },
    ],
  };

  methods = { loadOptions: { getNamespaces: namespaceOptions } };

  async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
    const parameter = (name: string, fallback: unknown = "") =>
      this.getNodeParameter(name, itemIndex, fallback);
    const { memdot } = await clientFor(this);
    const userId = String(parameter("userId")).trim();
    const query = String(parameter("query")).trim();
    const namespaceId = String(parameter("namespaceId")).trim();
    return supplyMemory(
      this,
      new Memory(memdot, {
        sessionId: String(parameter("sessionId")),
        windowSize: Number(parameter("windowSize", 10)),
        warn: (message) => this.logger.warn(message),
        ...(userId ? { userId } : {}),
        ...(query ? { query } : {}),
        ...(namespaceId ? { namespaceId } : {}),
      }),
    );
  }
}
