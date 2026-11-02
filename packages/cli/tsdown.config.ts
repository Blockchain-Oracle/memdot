import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: "esm",
  platform: "node",
  // One installable package with nothing to resolve: plugins unpack it without npm.
  noExternal: [/^@memdot\//, /^@polkadot-api\/descriptors/, /^commander$/],
  dts: false,
});
