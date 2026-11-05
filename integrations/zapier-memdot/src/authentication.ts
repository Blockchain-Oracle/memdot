import type { Authentication, Bundle, ZObject } from "zapier-platform-core";
import { DEFAULT_API_URL, KEY_PREFIX_CHARS } from "./constants.js";

const test = async (z: ZObject) => {
  // Any read proves the key. This one also proves it can see where memories live.
  const response = await z.request({ url: "/v1/namespaces" });
  return response.data;
};

export default {
  type: "custom",
  fields: [
    {
      key: "apiKey",
      label: "API Key",
      type: "password",
      required: true,
      helpText:
        "A key from **API keys** in the [MemDot dashboard](https://app.84.46.247.92.sslip.io). It reaches Assisted namespaces, where MemDot can read text to search it.",
    },
    {
      key: "apiUrl",
      label: "API URL",
      type: "string",
      required: false,
      default: DEFAULT_API_URL,
      helpText: "Change this only if you run MemDot yourself.",
    },
  ],
  test,
  connectionLabel: async (_z: ZObject, bundle: Bundle) =>
    `MemDot ${String(bundle.authData.apiKey ?? "").slice(0, KEY_PREFIX_CHARS)}…`,
} satisfies Authentication;
