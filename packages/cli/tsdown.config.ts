import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  platform: "node",
  // One installable package: everything of ours is inside it, so it needs nothing unpublished.
  noExternal: [/^@memdot\//, /^@polkadot-api\/descriptors/],
  dts: false,
});
