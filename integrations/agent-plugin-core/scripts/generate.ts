import { execFileSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import {
  antigravity,
  claudeCode,
  codex,
  cursor,
  type Files,
  kimi,
  marketplaces,
  portable,
  ROOT,
} from "./hosts.js";

const CORE_DIR = new URL("../", import.meta.url).pathname;
const BUILD_DIR = join(CORE_DIR, ".build");
const LAUNCHER = "memdot-plugin.mjs";

/** Every generated plugin, by folder. These are committed: a plugin installs from the repository as it is. */
const PLUGINS: Record<string, { files: () => Files; bundles?: string[] }> = {
  "claude-code-plugin": { files: claudeCode },
  "codex-plugin": { files: codex },
  "cursor-plugin": { files: cursor },
  "kimi-plugin": { files: kimi },
  "antigravity-plugin": { files: antigravity },
  "memdot-agent-plugin": { files: portable },
};

function writeAll(root: string, files: Files): void {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

export function buildBundles(): void {
  execFileSync("pnpm", ["exec", "tsdown"], {
    cwd: CORE_DIR,
    stdio: ["ignore", "ignore", "inherit"],
  });
}

/** Writes the whole generated tree under `root`. */
function generate(root: string): void {
  for (const [dir, plugin] of Object.entries(PLUGINS)) {
    const target = join(root, "integrations", dir);
    writeAll(target, plugin.files());
    mkdirSync(join(target, "core"), { recursive: true });
    for (const bundle of [LAUNCHER, ...(plugin.bundles ?? [])]) {
      cpSync(join(BUILD_DIR, bundle), join(target, "core", bundle));
    }
    chmodSync(join(target, "core", LAUNCHER), 0o644);
  }
  writeAll(root, marketplaces());
}

function walk(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

/** The generated tree against what's committed. Hand edits and stale output both show up here. */
export function drift(): string[] {
  const staged = mkdtempSync(join(tmpdir(), "memdot-plugin-"));
  try {
    generate(staged);
    const problems: string[] = [];
    const scan = (dir: string) => {
      const fresh = new Set(walk(join(staged, dir)).map((path) => relative(staged, path)));
      for (const path of fresh) {
        const committed = join(ROOT, path);
        if (!existsSync(committed)) problems.push(`missing: ${path}`);
        else if (!readFileSync(committed).equals(readFileSync(join(staged, path)))) {
          problems.push(`differs: ${path}`);
        }
      }
      for (const path of walk(join(ROOT, dir))) {
        const name = relative(ROOT, path);
        if (!fresh.has(name)) problems.push(`left over: ${name}`);
      }
    };
    for (const dir of Object.keys(PLUGINS)) scan(join("integrations", dir));
    for (const path of Object.keys(marketplaces())) {
      const committed = join(ROOT, path);
      if (!existsSync(committed) || readFileSync(committed).toString() !== marketplaces()[path]) {
        problems.push(`differs: ${path}`);
      }
    }
    return problems;
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  buildBundles();
  if (process.argv.includes("--check")) {
    const problems = drift();
    for (const problem of problems) console.error(problem);
    if (problems.length) {
      console.error(
        "\nThe plugins are out of date. Run: pnpm --filter @memdot/agent-plugin-core generate",
      );
      process.exit(1);
    }
    console.log("Every generated plugin matches its source.");
  } else {
    for (const dir of Object.keys(PLUGINS))
      rmSync(join(ROOT, "integrations", dir), { recursive: true, force: true });
    generate(ROOT);
    console.log(`Generated ${Object.keys(PLUGINS).length} plugins and the marketplace manifests.`);
  }
}
