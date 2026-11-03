import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_APP_URL } from "@memdot/config";
import { PLUGIN_VERSION as VERSION } from "../src/constants.js";

export const ROOT = new URL("../../../", import.meta.url).pathname;
const CORE = new URL("../", import.meta.url).pathname;

export const MARKETPLACE = "memdot-plugins";
export const NAME = "memdot";
export const DISPLAY_NAME = "MemDot";
export const REPOSITORY = "https://github.com/Blockchain-Oracle/memdot";
export const DESCRIPTION =
  "Long-term memory for coding agents: encrypted on your device, stored on Portaldot V3, and yours to move or revoke.";
const LICENSE = "Apache-2.0";
const KEYWORDS = ["memory", "coding-agents", "encrypted", "portaldot", "mcp"];
const AUTHOR = { name: "Blockchain-Oracle", url: "https://github.com/Blockchain-Oracle" };
export const KIMI_ZIP_URL = `${DEFAULT_APP_URL}/plugins/memdot-kimi.zip`;

const ABOUT = {
  version: VERSION,
  description: DESCRIPTION,
  homepage: REPOSITORY,
  repository: REPOSITORY,
  license: LICENSE,
  keywords: KEYWORDS,
};

const LAUNCHER = 'node "$HOME/.memdot/bin/memdot-plugin.mjs"';
/** A variable the host fills in, written the way its config files expect. */
const hostVar = (name: string) => `\${${name}}`;
const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
export type Files = Record<string, string>;

/** Which frontmatter fields each host's skills can carry, beyond name and description. */
const RICH_FRONTMATTER = ["argument-hint", "disable-model-invocation"];

interface SkillStyle {
  hostName: string;
  /** Hosts that namespace a plugin's skills themselves don't need it in the name. */
  prefix: string;
  keepFields: string[];
  /** A host that fills in what the person typed after the skill's name. */
  argumentsLine: string;
  /** One more step at the end of logging in, on a host that needs it. */
  afterLogin?: string;
}

export function renderSkills(style: SkillStyle): Files {
  const source = join(CORE, "skills");
  const files: Files = {};
  for (const name of readdirSync(source).sort()) {
    const raw = readFileSync(join(source, name, "SKILL.md"), "utf8");
    const [, front = "", body = ""] = raw.split(/^---$/m);
    const fields = front
      .trim()
      .split("\n")
      .filter((line) => {
        const key = line.split(":")[0] as string;
        return key === "name" || key === "description" || style.keepFields.includes(key);
      })
      .map((line) => (line.startsWith("name:") ? `name: ${style.prefix}${name}` : line));
    const rendered = `---\n${fields.join("\n")}\n---${body}`
      .replaceAll("{{MEMDOT}}", LAUNCHER)
      .replaceAll("{{HOST_NAME}}", style.hostName)
      .replaceAll("{{AFTER_LOGIN}}", style.afterLogin ? `\n${style.afterLogin}\n` : "")
      .replaceAll("{{ARGUMENTS}}\n\n", style.argumentsLine ? `${style.argumentsLine}\n\n` : "");
    if (/\{\{|\}\}/.test(rendered)) throw new Error(`Unfilled placeholder in skill ${name}`);
    files[`skills/${style.prefix}${name}/SKILL.md`] = rendered;
  }
  return files;
}

const sidekickBody = () => readFileSync(join(CORE, "agents", "sidekick.md"), "utf8");
const SIDEKICK_DESCRIPTION =
  "Takes on one bounded piece of a larger coding task on a cheaper model, in its own git worktree: investigating, implementing, testing or reviewing. Keep quick changes and decisions with the main agent. Say exactly what to do, what constrains it, and what to report back.";

function sidekick(front: Record<string, string>): string {
  const lines = Object.entries(front).map(([key, value]) => `${key}: ${value}`);
  return `---\nname: sidekick\ndescription: ${SIDEKICK_DESCRIPTION}\n${lines.join("\n")}\n---\n\n${sidekickBody()}`;
}

function readme(title: string, install: string, notes: string[]): string {
  return `# MemDot for ${title}

${DESCRIPTION}

Generated from \`integrations/agent-plugin-core\`. Edit it there.

## Install

${install}

Needs Node 22.12 or later. The first session unpacks the MemDot CLI into \`~/.memdot\`.

## Connect

Run the MemDot login skill, or \`memdot login\`. You approve it in your browser and choose which spaces this agent can reach. Private namespaces stay encrypted: this machine decrypts them with the agent's own key.

## What it does here

${notes.map((note) => `- ${note}`).join("\n")}
`;
}

// ── Hook hosts ─────────────────────────────────────────────────────────────────────────────────

const CLAUDE_ROOT = hostVar("CLAUDE_PLUGIN_ROOT");
const claudeCommand = (root: string, host: string, event: string) =>
  `node "${root}/core/memdot-plugin.mjs" hook ${host} ${event}`;

function claudeStyleHooks(root: string, host: string) {
  const command = (event: string, timeout: number, extra: Record<string, unknown> = {}) => ({
    type: "command",
    command: claudeCommand(root, host, event),
    timeout,
    ...extra,
  });
  const background = { async: true };
  const sidekickOnly = { matcher: "^memdot:sidekick$" };
  return {
    SessionStart: [
      { matcher: "startup|resume|clear|compact", hooks: [command("session-start", 5)] },
    ],
    UserPromptSubmit: [{ hooks: [command("prompt", 15)] }],
    PostToolUse: [{ matcher: ".*", hooks: [command("tool", 5, background)] }],
    PostToolUseFailure: [{ matcher: ".*", hooks: [command("tool-failure", 5, background)] }],
    SubagentStart: [{ ...sidekickOnly, hooks: [command("subagent-start", 5)] }],
    SubagentStop: [{ ...sidekickOnly, hooks: [command("subagent-stop", 5)] }],
    Stop: [{ hooks: [command("stop", 5)] }],
    PreCompact: [
      {
        hooks: [command("compact", 5, { statusMessage: "Saving memories from this session..." })],
      },
    ],
    SessionEnd: [{ hooks: [command("session-end", 3)] }],
  };
}

export function claudeCode(): Files {
  const option = (name: string) => hostVar(`user_config.${name}`);
  return {
    ".claude-plugin/plugin.json": pretty({
      name: NAME,
      displayName: DISPLAY_NAME,
      ...ABOUT,
      author: AUTHOR,
      userConfig: {
        api_key: {
          type: "string",
          title: "API key (optional)",
          description:
            "Only if you'd rather paste a key than run the login skill. A key alone reaches Assisted namespaces, not Private ones.",
          sensitive: true,
        },
        namespace: {
          type: "string",
          title: "Namespace (optional)",
          description: "Where memories go. Login sets this for you.",
        },
        user_id: {
          type: "string",
          title: "Your memory id (optional)",
          description:
            "Keeps your preferences together across machines. Defaults to your account name here.",
        },
        top_k: {
          type: "number",
          title: "Results per search",
          description: "How many memories a search returns.",
          default: 5,
          min: 1,
          max: 20,
        },
        max_context_chars: {
          type: "number",
          title: "Most text to recall",
          description: "The most memory text added to a conversation at once.",
          default: 4000,
          min: 1000,
          max: 10000,
        },
        search_scope: {
          type: "string",
          title: "What a search reaches",
          description:
            "repo: this repository plus your own preferences. mine: everything of yours. all: the whole namespace.",
          default: "repo",
          options: ["repo", "mine", "all"],
        },
        checkpoint_exchanges: {
          type: "number",
          title: "Save after this many turns",
          description:
            "Each save uses a model call and a chain write. Whatever's left also saves at compaction and at the end of a session.",
          default: 10,
          min: 1,
          max: 100,
        },
        auto_save: {
          type: "boolean",
          title: "Save automatically",
          description: "Turn off to save only when asked.",
          default: true,
        },
      },
    }),
    ".mcp.json": pretty({
      mcpServers: {
        memdot: {
          command: "node",
          args: [`${CLAUDE_ROOT}/core/memdot-plugin.mjs`, "mcp", "claude-code"],
          env: {
            MEMDOT_API_KEY: option("api_key"),
            MEMDOT_NAMESPACE: option("namespace"),
          },
        },
      },
    }),
    "hooks/hooks.json": pretty({
      description:
        "Recall memories at the start of work, record what happened, and save checkpoints in the background.",
      hooks: claudeStyleHooks(CLAUDE_ROOT, "claude-code"),
    }),
    "agents/sidekick.md": sidekick({
      model: "sonnet",
      effort: "medium",
      tools:
        "Read, Grep, Glob, Bash, Edit, Write, WebFetch, WebSearch, Monitor, SendMessage, Skill, mcp__plugin_memdot_memdot__search_memories",
      isolation: "worktree",
      color: "cyan",
    }),
    ...renderSkills({
      hostName: "Claude Code",
      prefix: "",
      keepFields: RICH_FRONTMATTER,
      argumentsLine: "The person asked for: $ARGUMENTS",
    }),
    "README.md": readme(
      "Claude Code",
      `\`\`\`bash
claude plugin marketplace add Blockchain-Oracle/memdot
claude plugin install memdot@${MARKETPLACE}
\`\`\``,
      [
        "The first prompt of a session searches this repository's memories and adds what it finds.",
        "Every tool call is noted locally, with secrets removed and no file contents.",
        "Every 10 turns, at compaction and at the end of a session, the conversation is saved in the background.",
        "`/memdot:search`, `/memdot:remember`, `/memdot:forget`, `/memdot:status`, `/memdot:pause`, `/memdot:resume`, `/memdot:login`.",
        "The `memdot:sidekick` agent does bounded work on a cheaper model in its own worktree, starting from what was recalled.",
        "The full MemDot MCP server, for memories and encrypted files.",
      ],
    ),
  };
}

export function codex(): Files {
  const root = hostVar("PLUGIN_ROOT");
  return {
    "plugin.json": pretty({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: NAME,
      ...ABOUT,
      author: AUTHOR,
      extensions: {
        "com.openai": {
          interface: {
            displayName: DISPLAY_NAME,
            shortDescription: "Encrypted long-term memory on Portaldot V3",
            longDescription: DESCRIPTION,
            developerName: AUTHOR.name,
            category: "Productivity",
            websiteURL: REPOSITORY,
          },
        },
      },
    }),
    "mcp.json": pretty({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {
        memdot: {
          type: "stdio",
          command: "node",
          args: [`${root}/core/memdot-plugin.mjs`, "mcp", "codex"],
        },
      },
    }),
    ...renderSkills({
      hostName: "Codex",
      prefix: "memdot-",
      keepFields: [],
      argumentsLine: "",
      afterLogin: `4. Codex's CLI only runs hooks from its own config, so add MemDot's there, and tell them to open \`/hooks\` once and trust them:

   \`\`\`bash
   ${LAUNCHER} setup codex
   \`\`\``,
    }),
    "README.md": readme(
      "Codex",
      `\`\`\`bash
codex plugin marketplace add Blockchain-Oracle/memdot
codex plugin add memdot@${MARKETPLACE}
\`\`\`

Codex's CLI runs hooks from its own config, not from plugins, so one more step adds them there. Start Codex once so the plugin is in place, then:

\`\`\`bash
${LAUNCHER} setup codex
\`\`\`

Then open \`/hooks\` in Codex and trust MemDot's hooks. Codex skips any hook you haven't reviewed.`,
      [
        "The first prompt of a session searches this repository's memories and adds what it finds.",
        "Every tool call is noted locally, with secrets removed and no file contents.",
        "Every 10 turns, at compaction and at the end of a session, the conversation is saved in the background.",
        "Skills: `memdot-search`, `memdot-remember`, `memdot-forget`, `memdot-status`, `memdot-pause`, `memdot-resume`, `memdot-login`.",
        "The full MemDot MCP server. Codex has no plugin options, so settings come from `MEMDOT_*` environment variables.",
        "No sidekick agent: Codex plugins can't carry agent definitions.",
      ],
    ),
  };
}

export function cursor(): Files {
  const root = hostVar("CURSOR_PLUGIN_ROOT");
  const hook = (event: string, timeout = 5) => ({
    command: claudeCommand(root, "cursor", event),
    timeout,
  });
  return {
    ".cursor-plugin/plugin.json": pretty({ name: NAME, ...ABOUT, author: { name: AUTHOR.name } }),
    "mcp.json": pretty({
      mcpServers: {
        memdot: { command: "node", args: [`${root}/core/memdot-plugin.mjs`, "mcp", "cursor"] },
      },
    }),
    "hooks/hooks.json": pretty({
      version: 1,
      hooks: {
        sessionStart: [hook("sessionStart")],
        beforeSubmitPrompt: [hook("beforeSubmitPrompt", 15)],
        postToolUse: [hook("postToolUse")],
        postToolUseFailure: [hook("postToolUseFailure")],
        afterAgentResponse: [hook("afterAgentResponse")],
        stop: [hook("stop")],
        preCompact: [hook("preCompact")],
        sessionEnd: [hook("sessionEnd")],
      },
    }),
    "agents/sidekick.md": sidekick({}),
    ...renderSkills({
      hostName: "Cursor",
      prefix: "memdot-",
      keepFields: ["disable-model-invocation"],
      argumentsLine: "",
    }),
    "README.md": readme(
      "Cursor",
      `\`\`\`bash
agent plugin marketplace add ${REPOSITORY}
\`\`\`

Then install MemDot from Cursor's Customize page. To try it for one run instead, from a clone:

\`\`\`bash
agent --plugin-dir integrations/cursor-plugin
\`\`\``,
      [
        "Cursor can't add context to a prompt, so what the first prompt finds arrives with the first tool result. Answers that use no tools don't get it, but the MCP tools are always there.",
        "Every tool call is noted locally, with secrets removed and no file contents.",
        "Every 10 turns, at compaction and at the end of a session, the conversation is saved in the background.",
        "`/memdot-search`, `/memdot-remember`, `/memdot-forget`, `/memdot-status`, `/memdot-pause`, `/memdot-resume`, `/memdot-login`.",
        "The `sidekick` agent, and the full MemDot MCP server.",
      ],
    ),
  };
}

export function kimi(): Files {
  const command = (event: string) => `node ./core/memdot-plugin.mjs hook kimi ${event}`;
  const rule = (event: string, timeout = 5) => ({ event, command: command(event), timeout });
  return {
    "kimi.plugin.json": pretty({
      name: NAME,
      version: VERSION,
      description: DESCRIPTION,
      keywords: KEYWORDS,
      author: AUTHOR,
      homepage: REPOSITORY,
      license: LICENSE,
      interface: {
        displayName: DISPLAY_NAME,
        shortDescription: "Encrypted long-term memory on Portaldot V3",
        longDescription: DESCRIPTION,
        developerName: AUTHOR.name,
        websiteURL: REPOSITORY,
      },
      skills: "./skills/",
      mcpServers: {
        memdot: { command: "node", args: ["./core/memdot-plugin.mjs", "mcp", "kimi"] },
      },
      hooks: [
        rule("SessionStart"),
        rule("UserPromptSubmit", 15),
        rule("PostToolUse"),
        rule("PostToolUseFailure"),
        rule("SubagentStart"),
        rule("SubagentStop"),
        rule("Stop"),
        rule("PreCompact"),
        rule("SessionEnd"),
      ],
    }),
    "agents/sidekick.md": sidekick({}),
    ...renderSkills({
      hostName: "Kimi Code",
      prefix: "",
      keepFields: ["disable-model-invocation"],
      argumentsLine: "",
    }),
    "README.md": readme(
      "Kimi Code",
      `In Kimi Code:

\`\`\`text
/plugins install ${KIMI_ZIP_URL}
\`\`\`

Kimi can't install from a folder inside a repository, so this is a zip of this folder, served from the MemDot site. From a clone, \`/plugins install /absolute/path/to/integrations/kimi-plugin\` works too.`,
      [
        "The first prompt of a session searches this repository's memories and adds what it finds.",
        "Every tool call is noted locally, with secrets removed and no file contents.",
        "Every 10 turns, at compaction and at the end of a session, the conversation is saved in the background.",
        "`/skill:memdot:search`, `remember`, `forget`, `status`, `pause`, `resume` and `login`.",
        "The `sidekick` agent, and the full MemDot MCP server. Kimi has no plugin options, so settings come from `MEMDOT_*` environment variables.",
      ],
    ),
  };
}

export function antigravity(): Files {
  const command = (event: string, timeout = 5) => ({
    type: "command",
    command: `node ./core/memdot-plugin.mjs hook antigravity ${event}`,
    timeout,
  });
  return {
    "plugin.json": pretty({
      $schema: "https://antigravity.google/schemas/v1/plugin.json",
      name: NAME,
      displayName: DISPLAY_NAME,
      ...ABOUT,
      author: AUTHOR,
    }),
    "mcp_config.json": pretty({
      mcpServers: {
        memdot: {
          command: "node",
          args: [`${hostVar("PLUGIN_ROOT")}/core/memdot-plugin.mjs`, "mcp", "antigravity"],
        },
      },
    }),
    "hooks.json": pretty({
      memdot: {
        enabled: true,
        SessionStart: [command("SessionStart")],
        PreInvocation: [command("PreInvocation", 15)],
        PostToolUse: [{ matcher: "*", hooks: [command("PostToolUse")] }],
        Stop: [command("Stop")],
      },
    }),
    "agents/sidekick.md": sidekick({}),
    ...renderSkills({
      hostName: "Antigravity",
      prefix: "memdot-",
      keepFields: ["disable-model-invocation"],
      argumentsLine: "",
    }),
    "README.md": readme(
      "Antigravity",
      `From a clone of the repository:

\`\`\`bash
agy plugin install ./integrations/antigravity-plugin
\`\`\``,
      [
        "The first prompt of a session searches this repository's memories and adds what it finds.",
        "Every tool call is noted locally, with secrets removed and no file contents.",
        "Every 10 turns the conversation is saved in the background. Antigravity reports no session end, so what's left over goes at the start of the next session.",
        "`/memdot-search`, `/memdot-remember`, `/memdot-forget`, `/memdot-status`, `/memdot-pause`, `/memdot-resume`, `/memdot-login`.",
        "The `sidekick` agent, and the full MemDot MCP server.",
      ],
    ),
  };
}

export function portable(): Files {
  return {
    "plugin.json": pretty({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: NAME,
      ...ABOUT,
      author: AUTHOR,
    }),
    "mcp.json": pretty({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {
        memdot: {
          type: "stdio",
          command: "node",
          args: [`${hostVar("PLUGIN_ROOT")}/core/memdot-plugin.mjs`, "mcp", "agent-plugin"],
        },
      },
    }),
    ...renderSkills({
      hostName: "your agent",
      prefix: "memdot-",
      keepFields: [],
      argumentsLine: "",
    }),
    "README.md": readme(
      "any Agent Plugins host",
      "Install this folder the way your client installs an Agent Plugins v1 package.",
      [
        "The MemDot MCP server and the skills. The standard has no lifecycle hooks, so nothing is recalled or saved on its own: the agent uses the tools.",
      ],
    ),
  };
}

// ── Hosts that load a plugin in-process ────────────────────────────────────────────────────────

const packageJson = (name: string, main: string, extra: Record<string, unknown> = {}) =>
  pretty({
    name: `@memdot/${name}`,
    version: VERSION,
    description: DESCRIPTION,
    license: LICENSE,
    type: "module",
    main,
    exports: { ".": { import: main } },
    repository: REPOSITORY,
    keywords: KEYWORDS,
    ...extra,
  });

const TOOL_NOTE =
  "Tools: `memdot_search`, `memdot_remember`, `memdot_list`, `memdot_get`, `memdot_forget`, `memdot_status`.";
const LIFECYCLE_NOTE =
  "The first prompt of a session searches this repository's memories and adds what it finds. Tool calls are noted locally, with secrets removed. Every 10 turns, at compaction and at the end of a session, the conversation is saved in the background.";
const SKILLS_FOR = (hostName: string, keepFields: string[] = []) => ({
  hostName,
  prefix: "memdot-",
  keepFields,
  argumentsLine: "",
});

export function opencode(): Files {
  return {
    "package.json": packageJson("opencode-plugin", "./core/opencode.mjs"),
    ...renderSkills(SKILLS_FOR("OpenCode")),
    "README.md": readme(
      "OpenCode",
      `From a clone of the repository, add it to \`opencode.json\`, global or per project:

\`\`\`json
{ "plugin": ["file:///absolute/path/to/integrations/opencode-plugin/core/opencode.mjs"] }
\`\`\``,
      [
        LIFECYCLE_NOTE,
        TOOL_NOTE,
        "The full MemDot MCP server, and the skills as `/memdot-search` and so on.",
      ],
    ),
  };
}

export function pi(): Files {
  return {
    "package.json": packageJson("pi-agent-plugin", "./core/pi.mjs", {
      keywords: [...KEYWORDS, "pi-package"],
      pi: { extensions: ["./core/pi.mjs"], skills: ["./skills"] },
    }),
    ...renderSkills(SKILLS_FOR("Pi", ["disable-model-invocation"])),
    "README.md": readme(
      "Pi",
      `From a clone of the repository:

\`\`\`bash
pi install ./integrations/pi-agent-plugin
\`\`\``,
      [LIFECYCLE_NOTE, TOOL_NOTE, "The skills, as `/skill:memdot-search` and so on."],
    ),
  };
}

export function openclaw(): Files {
  const toolNames = [
    "memdot_search",
    "memdot_remember",
    "memdot_list",
    "memdot_get",
    "memdot_forget",
    "memdot_status",
  ];
  return {
    "package.json": packageJson("openclaw-plugin", "./core/openclaw.mjs", {
      openclaw: {
        extensions: ["./core/openclaw.mjs"],
        compat: { pluginApi: ">=2026.4.24", minGatewayVersion: "2026.4.24" },
      },
    }),
    "openclaw.plugin.json": pretty({
      id: NAME,
      name: DISPLAY_NAME,
      description: DESCRIPTION,
      version: VERSION,
      skills: ["skills"],
      contracts: { tools: toolNames },
      activation: { onStartup: true },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
    ...renderSkills(SKILLS_FOR("OpenClaw", ["disable-model-invocation"])),
    "README.md": readme(
      "OpenClaw",
      `From a clone of the repository:

\`\`\`bash
openclaw plugins install ./integrations/openclaw-plugin
\`\`\`

OpenClaw won't show a third-party plugin the conversation until you allow it. Add this to its config, or recall and saving stay off while the tools still work:

\`\`\`json
{ "plugins": { "entries": { "memdot": { "hooks": { "allowConversationAccess": true } } } } }
\`\`\``,
      [
        LIFECYCLE_NOTE,
        TOOL_NOTE,
        "The skills.",
        "It doesn't take OpenClaw's exclusive memory slot, so it runs next to whatever memory you already use.",
      ],
    ),
  };
}

export function deepseek(): Files {
  return {
    "package.json": packageJson("deepseek-plugin", "./core/deepseek.mjs"),
    "README.md": readme(
      "DeepSeek Harness",
      `From a clone of the repository, pack it and add it to a profile:

\`\`\`bash
cd integrations/deepseek-plugin && npm pack
dsh plugin --profile default add ./memdot-deepseek-plugin-${VERSION}.tgz
\`\`\`

Then turn it on in that profile's \`cordis.patch.yml\`:

\`\`\`yaml
- insert:
    - id: memdot
      name: "@memdot/deepseek-plugin"
\`\`\``,
      [
        "The first request of a session searches this repository's memories and adds what it finds. Every 10 turns the conversation is saved in the background.",
        TOOL_NOTE,
        "No skills: the harness has no way to register them.",
      ],
    ),
  };
}

export function hermes(): Files {
  return {
    "plugin.yaml": `name: ${NAME}\nversion: "${VERSION}"\ndescription: "${DESCRIPTION}"\n`,
    "__init__.py": readFileSync(join(CORE, "hermes", "__init__.py"), "utf8"),
    "README.md": readme(
      "Hermes Agent",
      `From a clone of the repository:

\`\`\`bash
cp -r integrations/hermes-plugin ~/.hermes/plugins/memdot
hermes plugins enable memdot
\`\`\`

Then choose it with \`hermes memory setup memdot\`. Hermes runs one memory provider at a time.`,
      [
        "A Hermes memory provider. Recall happens before the first request of a session, and turns are saved in the background.",
        "Tools: `memdot_search`, `memdot_remember`, `memdot_forget`, `memdot_status`.",
        "It calls the same bundled core as every other plugin, by command, so it needs node on the PATH.",
      ],
    ),
  };
}

// ── Root marketplace manifests ─────────────────────────────────────────────────────────────────

export function marketplaces(): Files {
  const entry = { name: NAME, description: DESCRIPTION, version: VERSION };
  const owner = { name: AUTHOR.name, url: AUTHOR.url };
  const codexMarketplace = pretty({
    name: MARKETPLACE,
    interface: { displayName: DISPLAY_NAME },
    plugins: [
      {
        name: NAME,
        source: { source: "local", path: "./integrations/codex-plugin" },
        policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        category: "Productivity",
      },
    ],
  });
  return {
    ".claude-plugin/marketplace.json": pretty({
      name: MARKETPLACE,
      owner,
      metadata: { description: DESCRIPTION },
      plugins: [{ ...entry, source: "./integrations/claude-code-plugin" }],
    }),
    ".agents/plugins/marketplace.json": codexMarketplace,
    ".codex-plugin/marketplace.json": codexMarketplace,
    ".cursor-plugin/marketplace.json": pretty({
      name: MARKETPLACE,
      owner: { name: AUTHOR.name },
      metadata: { description: DESCRIPTION },
      plugins: [{ ...entry, source: "./integrations/cursor-plugin" }],
    }),
    ".kimi-plugin/marketplace.json": pretty({
      name: MARKETPLACE,
      version: "1",
      plugins: [
        {
          id: NAME,
          displayName: DISPLAY_NAME,
          version: VERSION,
          description: DESCRIPTION,
          homepage: REPOSITORY,
          keywords: KEYWORDS,
          source: KIMI_ZIP_URL,
        },
      ],
    }),
    "marketplace.json": pretty({
      name: MARKETPLACE,
      interface: { displayName: DISPLAY_NAME },
      plugins: [
        {
          ...entry,
          source: "./integrations/memdot-agent-plugin",
          policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
          category: "Productivity",
        },
      ],
    }),
  };
}
