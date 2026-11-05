import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    "credentials/MemDotApi.credentials": "credentials/MemDotApi.credentials.ts",
    "nodes/MemDot/MemDot.node": "nodes/MemDot/MemDot.node.ts",
    "nodes/MemDotChatMemory/MemDotChatMemory.node":
      "nodes/MemDotChatMemory/MemDotChatMemory.node.ts",
  },
  // n8n loads these with require(), and resolves anything it already holds from its own copy.
  format: "cjs",
  platform: "node",
  outExtensions: () => ({ js: ".js" }),
  noExternal: [/^(?!n8n-workflow$|@n8n\/ai-node-sdk$).*/],
  external: ["n8n-workflow", "@n8n/ai-node-sdk"],
  dts: false,
  // n8n reads icons by a path relative to the node's own file.
  copy: [
    { from: "icons/memdot.svg", to: "dist/credentials" },
    { from: "icons/memdot.dark.svg", to: "dist/credentials" },
    { from: "icons/memdot.svg", to: "dist/nodes/MemDot" },
    { from: "icons/memdot.dark.svg", to: "dist/nodes/MemDot" },
    { from: "icons/memdot.svg", to: "dist/nodes/MemDotChatMemory" },
    { from: "icons/memdot.dark.svg", to: "dist/nodes/MemDotChatMemory" },
  ],
});
