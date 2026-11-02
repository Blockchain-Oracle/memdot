import { defineConfig } from "tsdown";

const BANNER =
  "// Generated from integrations/agent-plugin-core. Edit it there, then run its generate script.";

/** Every plugin ships these as they are: installing a plugin runs no build and no package manager. */
const entries = {
  "memdot-plugin": "src/main.ts",
  opencode: "src/harness/opencode.ts",
  pi: "src/harness/pi.ts",
  openclaw: "src/harness/openclaw.ts",
  deepseek: "src/harness/deepseek.ts",
};

export default defineConfig(
  Object.entries(entries).map(([name, source]) => ({
    entry: { [name]: source },
    outDir: ".build",
    format: "esm" as const,
    platform: "node" as const,
    target: "node22",
    deps: { alwaysBundle: [/.*/] },
    dts: false,
    clean: false,
    banner: { js: BANNER },
  })),
);
