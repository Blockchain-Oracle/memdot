import { DEFAULT_API_URL } from "@memdot/config";
import type {
  IAuthenticateGeneric,
  ICredentialTestRequest,
  ICredentialType,
  Icon,
  INodeProperties,
} from "n8n-workflow";

export class MemDotApi implements ICredentialType {
  name = "memDotApi";

  displayName = "MemDot API";

  icon: Icon = { light: "file:memdot.svg", dark: "file:memdot.dark.svg" };

  documentationUrl =
    "https://github.com/Blockchain-Oracle/memdot/tree/main/integrations/n8n-nodes-memdot";

  properties: INodeProperties[] = [
    {
      displayName: "API Key",
      name: "apiKey",
      type: "string",
      typeOptions: { password: true },
      default: "",
      required: true,
      description:
        "A key from API keys in the dashboard, or a connected agent's key. Enough for memories in Assisted namespaces.",
    },
    {
      displayName: "Agent Identity",
      name: "identity",
      type: "string",
      typeOptions: { password: true },
      default: "",
      description:
        "Only needed for files, which are encrypted here in n8n. Get one with: memdot login --print-env --label n8n. Anyone who can read this credential can open the spaces that agent reaches.",
    },
    {
      displayName: "API URL",
      name: "apiUrl",
      type: "string",
      default: DEFAULT_API_URL,
      description: "Change this only if you run MemDot yourself",
    },
  ];

  authenticate: IAuthenticateGeneric = {
    type: "generic",
    properties: {
      headers: { Authorization: "=Bearer {{$credentials.apiKey}}" },
    },
  };

  test: ICredentialTestRequest = {
    request: { baseURL: "={{$credentials.apiUrl}}", url: "/v1/namespaces", method: "GET" },
  };
}
