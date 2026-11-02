// Checks every generated plugin against what its host accepts, then runs each host's real hook
// commands, through the built bundle, against a stand-in CLI. Add --live to also ask installed hosts.
import { spawnSync } from "node:child_process";
import {
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
import { join } from "node:path";
import { buildBundles, drift } from "./generate.js";
import { MARKETPLACE, NAME, ROOT } from "./hosts.js";

let failures = 0;
let passes = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    passes += 1;
    return;
  }
  failures += 1;
  console.error(`✗ ${label}${detail === undefined ? "" : ` → ${JSON.stringify(detail)}`}`);
}
const section = (name: string) => console.log(`· ${name}`);

const integrations = join(ROOT, "integrations");
const pluginDir = (name: string) => join(integrations, name);
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const walk = (root: string): string[] =>
  readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(root, entry.name)) : [join(root, entry.name)],
  );
const allowedOnly = (value: object, allowed: string[]) =>
  Object.keys(value).filter((key) => !allowed.includes(key));

// ── Drift ──────────────────────────────────────────────────────────────────────────────────────

section("generated output");
buildBundles();
const problems = drift();
check("every plugin matches its source", problems.length === 0, problems);

const ALL_PLUGINS = readdirSync(integrations).filter((name) => name.endsWith("-plugin"));

// ── Skills and bundles, on every host ──────────────────────────────────────────────────────────

section("skills and bundles");
const SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const WANTED_SKILLS = ["search", "remember", "forget", "status", "pause", "resume", "login"];
const SKILL_FIELDS: Record<string, string[]> = {
  "claude-code-plugin": ["name", "description", "argument-hint", "disable-model-invocation"],
  "cursor-plugin": ["name", "description", "disable-model-invocation"],
  "kimi-plugin": ["name", "description", "disable-model-invocation"],
  "antigravity-plugin": ["name", "description", "disable-model-invocation"],
};
const SPEC_SKILL_FIELDS = ["name", "description"];
const REFERENCE_NAMES = /\b(?:mem0|walrus|supermemory|letta|zep)\b/i;
const bundle = readFileSync(join(ROOT, "integrations/claude-code-plugin/core/memdot-plugin.mjs"));

for (const plugin of ALL_PLUGINS) {
  const dir = pluginDir(plugin);
  const shipped = join(dir, "core/memdot-plugin.mjs");
  check(`${plugin}: ships the core`, existsSync(shipped));
  if (existsSync(shipped)) {
    check(`${plugin}: its core is the same bytes`, readFileSync(shipped).equals(bundle));
  }
  for (const file of walk(dir)) {
    const text = readFileSync(file, "utf8");
    check(`${plugin}: names no other product`, !REFERENCE_NAMES.test(text), file);
    if (file.endsWith(".json")) {
      try {
        JSON.parse(text);
      } catch (error) {
        check(`${file} parses`, false, String(error));
      }
    }
  }
  const skills = join(dir, "skills");
  if (!existsSync(skills)) continue;
  const names = readdirSync(skills);
  for (const wanted of WANTED_SKILLS) {
    check(
      `${plugin}: has the ${wanted} skill`,
      names.includes(wanted) || names.includes(`memdot-${wanted}`),
      names,
    );
  }
  for (const name of names) {
    const raw = readFileSync(join(skills, name, "SKILL.md"), "utf8");
    const front = raw.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";
    const fields = Object.fromEntries(
      front
        .split("\n")
        .map((line) => [line.split(":")[0], line.split(":").slice(1).join(":").trim()]),
    );
    check(`${plugin}/${name}: name matches its folder`, fields.name === name, fields.name);
    check(`${plugin}/${name}: name is valid`, SKILL_NAME.test(name));
    const description = fields.description ?? "";
    check(
      `${plugin}/${name}: has a description`,
      description.length > 0 && description.length <= 1024,
    );
    const unknown = allowedOnly(fields, SKILL_FIELDS[plugin] ?? SPEC_SKILL_FIELDS);
    check(`${plugin}/${name}: only fields its host reads`, unknown.length === 0, unknown);
    check(`${plugin}/${name}: no unfilled placeholder`, !/\{\{|\}\}/.test(raw));
  }
}

// ── Hook commands point at something real ──────────────────────────────────────────────────────

const CLAUDE_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "PostToolUseFailure",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "PreCompact",
  "SessionEnd",
];
const CODEX_EVENTS = CLAUDE_EVENTS.filter((event) => event !== "PostToolUseFailure");
const CURSOR_EVENTS = [
  "sessionStart",
  "sessionEnd",
  "postToolUse",
  "postToolUseFailure",
  "beforeSubmitPrompt",
  "preCompact",
  "stop",
  "afterAgentResponse",
];
const KIMI_EVENTS = [
  "SessionStart",
  "SessionEnd",
  "UserPromptSubmit",
  "PostToolUse",
  "PostToolUseFailure",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "PreCompact",
];
const ANTIGRAVITY_EVENTS = [
  "SessionStart",
  "PreToolUse",
  "PostToolUse",
  "PreInvocation",
  "PostInvocation",
  "Stop",
];

const MAX_SESSION_END_TIMEOUT = 3;

function nestedHooks(plugin: string, known: string[]): { event: string; command: string }[] {
  const { hooks } = readJson(join(pluginDir(plugin), "hooks/hooks.json"));
  const out: { event: string; command: string }[] = [];
  for (const [event, groups] of Object.entries(hooks) as [string, Record<string, unknown>[]][]) {
    check(`${plugin}: ${event} is an event it has`, known.includes(event));
    for (const group of groups) {
      const handlers = (group.hooks as Record<string, unknown>[] | undefined) ?? [group];
      for (const handler of handlers) {
        check(`${plugin}: ${event} has a command`, typeof handler.command === "string");
        out.push({ event, command: handler.command as string });
        if (event === "SessionEnd") {
          check(
            `${plugin}: SessionEnd fits its short budget`,
            (handler.timeout as number) <= MAX_SESSION_END_TIMEOUT,
          );
        }
      }
    }
  }
  return out;
}

const commandUsesCore = (plugin: string, command: string) =>
  check(
    `${plugin}: runs the bundled core`,
    /core\/memdot-plugin\.mjs" hook |\.\/core\/memdot-plugin\.mjs hook /.test(command),
    command,
  );

// ── Claude Code ────────────────────────────────────────────────────────────────────────────────

section("claude code");
{
  const dir = pluginDir("claude-code-plugin");
  const manifest = readJson(join(dir, ".claude-plugin/plugin.json"));
  check("claude: named as installed", manifest.name === NAME);
  check("claude: name isn't reserved", !/^(claude|anthropic|cc-plugin)/.test(manifest.name));
  const OPTION_FIELDS = [
    "type",
    "title",
    "description",
    "required",
    "default",
    "options",
    "multiple",
    "sensitive",
    "min",
    "max",
  ];
  for (const [key, option] of Object.entries(manifest.userConfig) as [
    string,
    Record<string, unknown>,
  ][]) {
    check(
      `claude: option ${key} has only known fields`,
      allowedOnly(option, OPTION_FIELDS).length === 0,
    );
    check(
      `claude: option ${key} is complete`,
      Boolean(option.type && option.title && option.description),
    );
    check(`claude: option ${key} isn't required`, !option.required);
  }
  for (const { command } of nestedHooks("claude-code-plugin", CLAUDE_EVENTS)) {
    commandUsesCore("claude", command);
    check("claude: no option in a shell command", !command.includes("user_config"));
  }
  const mcp = readJson(join(dir, ".mcp.json"));
  const server = mcp.mcpServers.memdot;
  check("claude: MCP runs the core", server.args[0].endsWith("/core/memdot-plugin.mjs"));
  for (const value of Object.values(server.env) as string[]) {
    const key = value.match(/user_config\.(\w+)/)?.[1];
    check("claude: MCP options are declared", Boolean(key && manifest.userConfig[key]));
  }
  const agent = readFileSync(join(dir, "agents/sidekick.md"), "utf8");
  check(
    "claude: sidekick sets nothing a plugin agent can't",
    !/^(hooks|mcpServers|permissionMode):/m.test(agent),
  );
  const marketplace = readJson(join(ROOT, ".claude-plugin/marketplace.json"));
  check("claude: marketplace has an owner", Boolean(marketplace.owner?.name));
  check("claude: entry name equals the manifest", marketplace.plugins[0].name === manifest.name);
  check(
    "claude: entry path exists",
    existsSync(join(ROOT, marketplace.plugins[0].source, ".claude-plugin/plugin.json")),
  );
  check("claude: versions agree", marketplace.plugins[0].version === manifest.version);
}

// ── Codex and Agent Plugins v1 ─────────────────────────────────────────────────────────────────

section("codex and agent plugins");
const AGENT_PLUGIN_NAME = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const AGENT_PLUGIN_FIELDS = [
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions",
];
for (const plugin of ["codex-plugin", "memdot-agent-plugin"]) {
  const dir = pluginDir(plugin);
  const manifest = readJson(join(dir, "plugin.json"));
  check(
    `${plugin}: declares the schema`,
    manifest.$schema === "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  );
  check(
    `${plugin}: name fits the standard`,
    AGENT_PLUGIN_NAME.test(manifest.name) && manifest.name.length <= 64,
  );
  check(`${plugin}: only standard fields`, allowedOnly(manifest, AGENT_PLUGIN_FIELDS).length === 0);
  const mcp = readJson(join(dir, "mcp.json"));
  check(
    `${plugin}: MCP declares the schema`,
    mcp.$schema === "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  );
  for (const server of Object.values(mcp.mcpServers) as Record<string, unknown>[]) {
    check(`${plugin}: stdio server`, server.type === "stdio");
    check(`${plugin}: command is one word`, /^[\w.-]+$/.test(server.command as string));
    check(`${plugin}: no placeholder in the command`, !String(server.command).includes("$"));
    check(`${plugin}: no secret in the config`, server.env === undefined);
  }
}
{
  const dir = pluginDir("codex-plugin");
  const manifest = readJson(join(dir, "plugin.json"));
  check(
    "codex: hooks path resolves",
    existsSync(join(dir, manifest.extensions["com.openai"].hooks)),
  );
  for (const { command } of nestedHooks("codex-plugin", CODEX_EVENTS))
    commandUsesCore("codex", command);
  const agents = readFileSync(join(ROOT, ".agents/plugins/marketplace.json"), "utf8");
  check(
    "codex: both marketplace paths agree",
    agents === readFileSync(join(ROOT, ".codex-plugin/marketplace.json"), "utf8"),
  );
  const [entry] = JSON.parse(agents).plugins;
  check("codex: entry resolves", existsSync(join(ROOT, entry.source.path, "plugin.json")));
  check(
    "codex: entry says who can install",
    Boolean(entry.policy?.installation && entry.policy?.authentication && entry.category),
  );
}

// ── Cursor ─────────────────────────────────────────────────────────────────────────────────────

section("cursor");
{
  const dir = pluginDir("cursor-plugin");
  const manifest = readJson(join(dir, ".cursor-plugin/plugin.json"));
  check("cursor: name fits", /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(manifest.name));
  const hooks = readJson(join(dir, "hooks/hooks.json"));
  check("cursor: hooks version", hooks.version === 1);
  for (const [event, handlers] of Object.entries(hooks.hooks) as [
    string,
    { command: string }[],
  ][]) {
    check(`cursor: ${event} exists`, CURSOR_EVENTS.includes(event));
    for (const handler of handlers) {
      commandUsesCore("cursor", handler.command);
      check("cursor: uses a variable it expands", handler.command.includes("CURSOR_PLUGIN_ROOT"));
    }
  }
  const mcp = JSON.stringify(readJson(join(dir, "mcp.json")));
  check(
    "cursor: MCP uses a variable it expands",
    mcp.includes("CURSOR_PLUGIN_ROOT") && !mcp.includes("{PLUGIN_"),
  );
  const { plugins, owner } = readJson(join(ROOT, ".cursor-plugin/marketplace.json"));
  check("cursor: marketplace has an owner", Boolean(owner?.name));
  check(
    "cursor: entry resolves",
    existsSync(join(ROOT, plugins[0].source, ".cursor-plugin/plugin.json")),
  );
}

// ── Kimi ───────────────────────────────────────────────────────────────────────────────────────

section("kimi");
{
  const dir = pluginDir("kimi-plugin");
  const manifest = readJson(join(dir, "kimi.plugin.json"));
  check("kimi: name fits the binary's rule", /^[a-z0-9][a-z0-9_-]{0,63}$/.test(manifest.name));
  check("kimi: skills are declared", manifest.skills === "./skills/");
  const UNSUPPORTED = ["tools", "apps", "inject", "configFile", "config_file", "bootstrap"];
  check(
    "kimi: nothing it ignores",
    UNSUPPORTED.every((field) => !(field in manifest)),
  );
  for (const rule of manifest.hooks as Record<string, unknown>[]) {
    check(
      "kimi: hook has only its four fields",
      allowedOnly(rule, ["event", "matcher", "command", "timeout"]).length === 0,
    );
    check(`kimi: ${rule.event} exists`, KIMI_EVENTS.includes(rule.event as string));
    check(
      "kimi: timeout in range",
      (rule.timeout as number) >= 1 && (rule.timeout as number) <= 600,
    );
    commandUsesCore("kimi", rule.command as string);
  }
  const { plugins } = readJson(join(ROOT, ".kimi-plugin/marketplace.json"));
  check("kimi: source isn't a repository subfolder", !/\/tree\//.test(plugins[0].source));
  check("kimi: entry has what it needs", Boolean(plugins[0].id && plugins[0].source));
}

// ── Antigravity ────────────────────────────────────────────────────────────────────────────────

section("antigravity");
{
  const dir = pluginDir("antigravity-plugin");
  const manifest = readJson(join(dir, "plugin.json"));
  const FIELDS = [
    "$schema",
    "name",
    "displayName",
    "description",
    "version",
    "disabled",
    "logo",
    "suggestedPrompts",
    "skills",
    "author",
    "homepage",
    "repository",
    "license",
    "keywords",
    "extensions",
  ];
  check("antigravity: name fits", /^[a-z0-9]+(-[a-z0-9]+)*$/.test(manifest.name));
  check("antigravity: only fields it allows", allowedOnly(manifest, FIELDS).length === 0);
  const groups = readJson(join(dir, "hooks.json"));
  for (const group of Object.values(groups) as Record<string, unknown>[]) {
    for (const [event, entries] of Object.entries(group)) {
      if (event === "enabled") continue;
      check(`antigravity: ${event} exists`, ANTIGRAVITY_EVENTS.includes(event));
      for (const entry of entries as Record<string, unknown>[]) {
        const handlers = (entry.hooks as Record<string, unknown>[] | undefined) ?? [entry];
        if (entry.matcher !== undefined)
          check("antigravity: matcher only on tool events", event.includes("ToolUse"));
        for (const handler of handlers) {
          check("antigravity: command handler", handler.type === "command");
          commandUsesCore("antigravity", handler.command as string);
        }
      }
    }
  }
  check(
    "antigravity: MCP uses its variable",
    JSON.stringify(readJson(join(dir, "mcp_config.json"))).includes("PLUGIN_ROOT"),
  );
}

// ── Root manifests ─────────────────────────────────────────────────────────────────────────────

section("marketplaces");
for (const path of [
  ".claude-plugin",
  ".agents/plugins",
  ".codex-plugin",
  ".cursor-plugin",
  ".kimi-plugin",
]) {
  check(
    `${path}: is the one marketplace`,
    readJson(join(ROOT, path, "marketplace.json")).name === MARKETPLACE,
  );
}
{
  const [entry] = readJson(join(ROOT, "marketplace.json")).plugins;
  check("root marketplace: entry resolves", existsSync(join(ROOT, entry.source, "plugin.json")));
}

// ── Behaviour: every host's real command, through the bundle, against a stand-in CLI ───────────

section("behaviour");
/** Made up, and split so that no scanner mistakes it for a real token. */
const SECRET = `ghp_${"abcdefghijklmnopqrstuvwxyz0123456789"}`;
const STUB = `import { appendFileSync, readFileSync } from "node:fs";
const args = process.argv.slice(2);
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = Buffer.concat(chunks).toString();
const fileAt = args.indexOf("-f");
const sent = fileAt >= 0 ? readFileSync(args[fileAt + 1], "utf8") : null;
appendFileSync(process.env.STUB_LOG, JSON.stringify({ args, input, sent }) + "\\n");
const command = args[1];
const answer = (data) => console.log(JSON.stringify({ status: "success", data }));
const refuse = (exit, code) => {
  console.log(JSON.stringify({ status: "error", error: { code, message: code }, data: null }));
  process.exit(exit);
};
const mode = process.env.STUB_MODE ?? "";
if (command === "search") {
  answer([{ id: "m1", memory: "Deploys go through Coolify", score: 0.9, metadata: { branch: "main" } }]);
} else if (command === "add") {
  if (mode === "limited") refuse(6, "LIMITED");
  if (mode === "no-model" && !args.includes("--no-infer")) refuse(5, "MODEL_REQUIRED");
  answer({ event_id: "e1", status: "SUCCEEDED", results: [{ id: "m2", memory: "Saved", event: "ADD" }] });
} else if (command === "namespace") {
  answer({ default_namespace_id: "n1", namespaces: [{ id: "n1", mode: "assisted" }] });
} else {
  answer({});
}
`;

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "memdot-conformance-"));
  const stub = join(home, "stub.mjs");
  writeFileSync(stub, STUB);
  const log = join(home, "stub.log");
  writeFileSync(log, "");
  const repo = join(home, "repo");
  mkdirSync(repo);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    MEMDOT_CREDENTIALS_DIR: join(home, "memdot"),
    MEMDOT_CLI: stub,
    MEMDOT_API_KEY: "md_conformance",
    STUB_LOG: log,
  };
  const calls = () =>
    readFileSync(log, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { args: string[]; input: string; sent: string | null });
  const ready = () => {
    const plugin = join(home, "memdot", "plugin");
    mkdirSync(plugin, { recursive: true });
    writeFileSync(
      join(plugin, "connection.json"),
      JSON.stringify({ namespaceId: "n1", mode: "assisted", privateReady: false }),
    );
  };
  return {
    home,
    repo,
    env,
    calls,
    ready,
    dispose: () => rmSync(home, { recursive: true, force: true }),
  };
}

const CORE = join(pluginDir("claude-code-plugin"), "core/memdot-plugin.mjs");
function hook(env: NodeJS.ProcessEnv, host: string, event: string, input: unknown) {
  const result = spawnSync("node", [CORE, "hook", host, event], {
    input: JSON.stringify(input),
    env,
    encoding: "utf8",
  });
  return { stdout: result.stdout.trim(), status: result.status };
}
function worker(env: NodeJS.ProcessEnv, host: string, ...args: string[]) {
  return spawnSync("node", [CORE, "worker", host, ...args], { env, encoding: "utf8" });
}
const sessionsOf = (home: string) => {
  const dir = join(home, "memdot/plugin/sessions");
  return existsSync(dir) ? readdirSync(dir).map((name) => join(dir, name)) : [];
};

const PROMPT = "How do we deploy this service to production?";
const FACT = "Deploys go through Coolify";

/** One host's events, spelled its own way, and how its answer should read. */
const HOSTS: {
  host: string;
  start: string;
  prompt: string;
  session: (cwd: string) => Record<string, unknown>;
  promptInput: Record<string, unknown>;
  read: (stdout: string) => string;
  startsWithContext: boolean;
}[] = [
  {
    host: "claude-code",
    start: "session-start",
    prompt: "prompt",
    session: (cwd) => ({ session_id: "s1", cwd }),
    promptInput: { prompt: PROMPT },
    read: (out) => JSON.parse(out).hookSpecificOutput.additionalContext,
    startsWithContext: true,
  },
  {
    host: "codex",
    start: "session-start",
    prompt: "prompt",
    session: (cwd) => ({ session_id: "s1", cwd }),
    promptInput: { prompt: PROMPT },
    read: (out) => JSON.parse(out).hookSpecificOutput.additionalContext,
    startsWithContext: true,
  },
  {
    host: "kimi",
    start: "SessionStart",
    prompt: "UserPromptSubmit",
    session: (cwd) => ({ session_id: "s1", cwd }),
    promptInput: { prompt: PROMPT },
    read: (out) => out,
    startsWithContext: false,
  },
];

for (const { host, start, prompt, session, promptInput, read, startsWithContext } of HOSTS) {
  const box = sandbox();
  const base = session(box.repo);
  const offline = { ...box.env };
  delete offline.MEMDOT_API_KEY;
  const notice = hook(offline, host, start, base);
  if (startsWithContext)
    check(`${host}: tells you when it isn't connected`, notice.stdout.includes("isn't connected"));
  else check(`${host}: stays quiet where it can't add context`, notice.stdout === "");
  const told = hook(offline, host, prompt, { ...base, ...promptInput });
  if (!startsWithContext)
    check(
      `${host}: tells you at the first prompt instead`,
      told.stdout.includes("isn't connected"),
    );
  rmSync(join(box.home, "memdot/plugin/sessions"), { recursive: true, force: true });

  box.ready();
  hook(box.env, host, start, base);
  const first = hook(box.env, host, prompt, { ...base, ...promptInput });
  check(
    `${host}: the first prompt recalls`,
    first.stdout !== "" && read(first.stdout).includes(FACT),
    first.stdout,
  );
  check(`${host}: exits cleanly`, first.status === 0);
  const again = hook(box.env, host, prompt, {
    ...base,
    prompt: "And what about the staging environment?",
  });
  check(`${host}: only the first prompt recalls`, again.stdout === "", again.stdout);
  box.dispose();
}

{
  const box = sandbox();
  box.ready();
  const base = { session_id: "s1", cwd: box.repo };
  hook(box.env, "claude-code", "session-start", base);
  hook(box.env, "claude-code", "prompt", {
    ...base,
    prompt: `My token is ${SECRET} so deploy with it please`,
  });
  hook(box.env, "claude-code", "tool", {
    ...base,
    tool_name: "Bash",
    tool_input: { command: `deploy --token=${SECRET}` },
    tool_response: { stdout: "ok" },
  });
  hook(box.env, "claude-code", "tool", {
    ...base,
    tool_name: "Write",
    tool_input: { file_path: join(box.repo, "a.ts"), content: `const key = "${SECRET}"` },
  });
  hook(box.env, "claude-code", "tool-failure", {
    ...base,
    tool_name: "Bash",
    tool_input: { command: "pnpm test" },
    error: `failed with ${SECRET}`,
  });
  hook(box.env, "claude-code", "stop", {
    ...base,
    last_assistant_message:
      "Deployed through Coolify, with the staging environment first, because the production one has to stay up. That is how this should be done from now on, every time.",
  });

  const [dir] = sessionsOf(box.home);
  const events = readFileSync(join(dir as string, "events.jsonl"), "utf8");
  check("secrets never reach the log", !events.includes(SECRET));
  check("file contents never reach the log", !events.includes("const key"));
  check(
    "the log is private",
    (statSync(join(dir as string, "events.jsonl")).mode & 0o777) === 0o600,
  );
  check("the session folder is private", (statSync(dir as string).mode & 0o777) === 0o700);
  check("state is private", (statSync(join(dir as string, "state.json")).mode & 0o777) === 0o600);

  // The stop above isn't a checkpoint yet; the end of the session is.
  const before = box.calls().filter((call) => call.args[1] === "add").length;
  check("one turn isn't a checkpoint", before === 0);
  worker(box.env, "claude-code", "flush", dir as string, "--force");
  const added = box.calls().find((call) => call.args[1] === "add");
  check("the end of a session saves", Boolean(added));
  const flags = added?.args ?? [];
  const sent = JSON.parse(added?.sent ?? "[]") as { role: string; content: string }[];
  check(
    "it files under the repository",
    flags[flags.indexOf("--agent-id") + 1]?.startsWith("repo-") === true,
  );
  check("it says who it's about", flags.includes("-u") && flags.includes("--run-id"));
  check("it sends what to keep", flags.includes("--prompt") && flags.includes("--categories"));
  check(
    "the conversation goes in order",
    sent[0]?.role === "user" && sent.at(-1)?.role === "assistant",
  );
  check("it says what changed", sent.at(-1)?.content.includes("a.ts") === true);
  check("it says what failed", sent.at(-1)?.content.includes("pnpm test") === true);
  check("nothing secret is sent", !added?.sent?.includes(SECRET));
  check(
    "what was sent is gone from disk",
    readdirSync(join(box.home, "memdot/plugin/pending")).length === 0,
  );

  const count = box.calls().length;
  worker(box.env, "claude-code", "flush", dir as string, "--force");
  check("nothing is sent twice", box.calls().length === count);
  box.dispose();
}

{
  const box = sandbox();
  box.ready();
  const base = { session_id: "s1", cwd: box.repo };
  const long = "We settled on deploying through Coolify from the main branch. ".repeat(6);
  hook(box.env, "claude-code", "session-start", base);
  hook(box.env, "claude-code", "prompt", { ...base, prompt: PROMPT });
  hook(box.env, "claude-code", "stop", { ...base, last_assistant_message: long });
  const [dir] = sessionsOf(box.home);

  const limited = { ...box.env, STUB_MODE: "limited" };
  worker(limited, "claude-code", "flush", dir as string, "--force");
  const pendingDir = join(box.home, "memdot/plugin/pending");
  const waiting = readdirSync(pendingDir).filter((name) => name.endsWith(".json"));
  check("a limit keeps the checkpoint", waiting.length === 1);
  const packet = JSON.parse(readFileSync(join(pendingDir, waiting[0] as string), "utf8"));
  check("and doesn't count against it", packet.attempts === 0 && packet.notBefore > Date.now());
  check("and says why", packet.lastError === "LIMITED");

  // Due again, with no model to extract with: a note goes instead.
  writeFileSync(
    join(pendingDir, waiting[0] as string),
    JSON.stringify({ ...packet, notBefore: 0 }),
  );
  worker({ ...box.env, STUB_MODE: "no-model" }, "claude-code", "flush", dir as string);
  const note = box.calls().find((call) => call.args.includes("--no-infer"));
  check("no model: a note is kept", Boolean(note?.input.includes("Asked:")));
  check(
    "and the checkpoint is done",
    readdirSync(pendingDir).filter((name) => name.endsWith(".json")).length === 0,
  );
  box.dispose();
}

{
  const box = sandbox();
  box.ready();
  const paused = spawnSync("node", [CORE, "pause"], { env: box.env, encoding: "utf8" });
  check("pause says so", paused.stdout.includes("stopped"));
  const base = { session_id: "s1", cwd: box.repo };
  const output = hook(box.env, "claude-code", "prompt", { ...base, prompt: PROMPT });
  check("paused: nothing recalled", output.stdout === "" && box.calls().length === 0);
  hook(box.env, "claude-code", "tool", { ...base, tool_name: "Read", tool_input: {} });
  check("paused: nothing recorded", sessionsOf(box.home).length === 0);
  spawnSync("node", [CORE, "resume"], { env: box.env, encoding: "utf8" });
  const resumed = hook(box.env, "claude-code", "prompt", { ...base, prompt: PROMPT });
  check("resume turns it back on", resumed.stdout.includes(FACT));
  box.dispose();
}

{
  const box = sandbox();
  box.ready();
  const base = { conversation_id: "c1", session_id: "s1", workspace_roots: [box.repo] };
  check(
    "cursor: start answers nothing or JSON",
    hook(box.env, "cursor", "sessionStart", base).status === 0,
  );
  const prompt = hook(box.env, "cursor", "beforeSubmitPrompt", { ...base, prompt: PROMPT });
  check("cursor: a prompt can only be allowed", JSON.parse(prompt.stdout).continue === true);
  const tool = hook(box.env, "cursor", "postToolUse", {
    ...base,
    tool_name: "Read",
    tool_input: {},
    tool_output: "x",
  });
  check(
    "cursor: what was found comes with the next tool",
    JSON.parse(tool.stdout).additional_context.includes(FACT),
  );
  const next = hook(box.env, "cursor", "postToolUse", {
    ...base,
    tool_name: "Read",
    tool_input: {},
    tool_output: "x",
  });
  check("cursor: and only once", next.stdout === "");
  box.dispose();
}

{
  const box = sandbox();
  box.ready();
  const transcript = join(box.home, "transcript.jsonl");
  writeFileSync(
    transcript,
    `${[
      JSON.stringify({
        status: "DONE",
        type: "USER_INPUT",
        content: `<USER_REQUEST>${PROMPT}</USER_REQUEST>`,
      }),
      JSON.stringify({
        status: "DONE",
        type: "PLANNER_RESPONSE",
        source: "MODEL",
        content: "Through Coolify.",
      }),
    ].join("\n")}\n`,
  );
  const base = { conversationId: "c1", workspacePaths: [box.repo], transcriptPath: transcript };
  const start = hook(box.env, "antigravity", "SessionStart", base);
  check("antigravity: start answers JSON", Array.isArray(JSON.parse(start.stdout).injectSteps));
  const first = hook(box.env, "antigravity", "PreInvocation", { ...base, invocationNum: 0 });
  check(
    "antigravity: finds the prompt in its transcript",
    JSON.parse(first.stdout).injectSteps[0].ephemeralMessage.includes(FACT),
  );
  const later = hook(box.env, "antigravity", "PreInvocation", { ...base, invocationNum: 1 });
  check(
    "antigravity: only the first invocation",
    JSON.parse(later.stdout).injectSteps.length === 0,
  );
  check(
    "antigravity: other hooks answer JSON",
    hook(box.env, "antigravity", "PostToolUse", {
      ...base,
      toolCall: { name: "view_file", args: {} },
    }).stdout === "{}",
  );
  check(
    "antigravity: stop answers JSON",
    hook(box.env, "antigravity", "Stop", base).stdout === "{}",
  );
  const [dir] = sessionsOf(box.home);
  check(
    "antigravity: finds the answer too",
    readFileSync(join(dir as string, "events.jsonl"), "utf8").includes("Through Coolify."),
  );
  box.dispose();
}

{
  // A broken hook call must never get in the host's way.
  const box = sandbox();
  const result = spawnSync("node", [CORE, "hook", "claude-code", "prompt"], {
    input: "not json",
    env: box.env,
    encoding: "utf8",
  });
  check("bad input doesn't fail the host", result.status === 0);
  const unknown = spawnSync("node", [CORE, "hook", "nobody", "prompt"], {
    input: "{}",
    env: box.env,
    encoding: "utf8",
  });
  check("an unknown host doesn't fail either", unknown.status === 0);
  box.dispose();
}

// ── Asking the hosts themselves ────────────────────────────────────────────────────────────────

if (process.argv.includes("--live")) {
  section("installed hosts");
  const has = (binary: string) =>
    spawnSync(binary, ["--version"], { encoding: "utf8" }).status === 0;
  if (has("claude")) {
    for (const target of [pluginDir("claude-code-plugin"), ROOT]) {
      const result = spawnSync("claude", ["plugin", "validate", target, "--strict"], {
        encoding: "utf8",
      });
      check(`claude validates ${target}`, result.status === 0, result.stdout);
    }
  } else {
    console.log("  claude isn't installed here");
  }
}

console.log(
  failures === 0
    ? `\nConformance passed: ${passes} checks.`
    : `\n${failures} of ${passes + failures} checks failed.`,
);
process.exit(failures === 0 ? 0 : 1);
