// S12: every integration, skill and example against a deployed service, installed the way a stranger
// installs them: the CLI and the n8n node from the site, Python from git, skills from GitHub. Spends a
// little tPOT and a few model calls. Writes docs/evidence when everything passes.
//
// MEMDOT_API_URL, MEMDOT_APP_URL, MEMDOT_API_KEY, MEMDOT_AGENT_IDENTITY (a connected agent),
// MEMDOT_PLAIN_KEY (a dashboard key), MEMDOT_NAMESPACE (Assisted), MEMDOT_SPACE,
// GOOGLE_GENERATIVE_AI_API_KEY. node scripts/journey-s12.mjs

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SKILLS_CLI = "skills@1.7.6";
const STEP_TIMEOUT_MS = 12 * 60 * 1000;
const EXPECTED_SKILLS = 5;

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name}.`);
  return value;
};
const api = required("MEMDOT_API_URL");
const app = required("MEMDOT_APP_URL");
const namespace = required("MEMDOT_NAMESPACE");
const space = required("MEMDOT_SPACE");
const plainKey = required("MEMDOT_PLAIN_KEY");
const modelKey = required("GOOGLE_GENERATIVE_AI_API_KEY");
required("MEMDOT_API_KEY");
required("MEMDOT_AGENT_IDENTITY");

let failures = 0;
function check(label, ok, detail) {
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : ` → ${String(detail ?? "").slice(-1200)}`}`);
  if (!ok) failures += 1;
}
const heading = (text) => console.log(`\n── ${text}`);

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      {
        maxBuffer: 64_000_000,
        timeout: STEP_TIMEOUT_MS,
        ...options,
        env: { ...process.env, ...options.env },
      },
      (error, stdout, stderr) =>
        resolve({ ok: !error, code: error?.code ?? 0, output: `${stdout}\n${stderr}`, stdout }),
    );
  });
}

const home = await mkdtemp(join(tmpdir(), "memdot-s12-"));
const evidence = {
  stage: "S12",
  at: new Date().toISOString(),
  api,
  app,
};

heading("The CLI, from the site");
const cliDir = join(home, "cli");
await mkdir(cliDir);
const installed = await run("npm", [
  "install",
  "--prefix",
  cliDir,
  "--no-audit",
  "--no-fund",
  "--ignore-scripts",
  `${app}/cli/memdot-cli.tgz`,
]);
check("it installs", installed.ok, installed.output);
const bin = join(cliDir, "node_modules/.bin");
const memdot = join(bin, "memdot");
const version = await run(memdot, ["version"]);
check("and runs", version.ok, version.output);
evidence.cli = version.stdout.trim();
const withCli = {
  PATH: `${bin}:${process.env.PATH}`,
  MEMDOT_CREDENTIALS_DIR: join(home, "memdot"),
};

heading("The CLI cookbook");
const cookbook = await run("bash", [join(ROOT, "examples/cli-cookbook/cookbook.sh")], {
  env: { ...withCli, SPACE: space },
});
check("every recipe works", cookbook.output.includes("Every recipe worked."), cookbook.output);
evidence.cookbookFile = cookbook.output.match(/Transaction (0x[0-9a-f]+)/)?.[1];

heading("An MCP client talking to memdot mcp");
const smoke = await run("node", [join(ROOT, "examples/mcp-clients/smoke.mjs"), memdot], {
  env: withCli,
});
check(
  "it lists tools, saves, finds and forgets",
  smoke.output.includes("The server works."),
  smoke.output,
);
evidence.mcpTools = Number(smoke.output.match(/(\d+) tools:/)?.[1]);

heading("The same memory in three frameworks");
for (const script of ["ai-sdk", "langchain", "mastra"]) {
  const result = await run("pnpm", ["--filter", "@memdot/example-framework-memory", script], {
    cwd: ROOT,
    env: {
      GOOGLE_API_KEY: modelKey,
      EXAMPLE_MODEL: process.env.EXAMPLE_MODEL ?? "gemini-2.5-flash",
    },
  });
  const answers = (result.output.match(/which only the first session was told/g) ?? []).length;
  check(`${script}: a new session answers from memory`, result.ok && answers > 0, result.output);
}

heading("Python agents sharing a memory, installed from git");
const venv = join(home, "venv");
const madeVenv = await run("uv", ["venv", "--quiet", venv]);
const pip = await run("uv", [
  "pip",
  "install",
  "--quiet",
  "--python",
  join(venv, "bin/python"),
  "memdot @ git+https://github.com/Blockchain-Oracle/memdot.git#subdirectory=python/memdot",
]);
check("it installs", madeVenv.ok && pip.ok, pip.output);
const team = await run(
  join(venv, "bin/python"),
  [join(ROOT, "examples/python-shared-memory/team.py")],
  {
    env: { GEMINI_API_KEY: modelKey },
  },
);
check("three agents, one memory", team.output.includes("everyone's words signed"), team.output);

heading("n8n, with the node from the site");
const n8n = await run("pnpm", ["exec", "tsx", "scripts/journey.mts"], {
  cwd: join(ROOT, "integrations/n8n-nodes-memdot"),
  env: { N8N_PACKAGE_URL: `${app}/n8n/n8n-nodes-memdot.tgz` },
});
console.log(
  n8n.output
    .split("\n")
    .filter((line) => /^[✓✗]/.test(line))
    .join("\n"),
);
check("every step holds", n8n.ok && n8n.output.includes("Everything held."), n8n.output);
const n8nEvidence = n8n.output.match(/EVIDENCE (\{.*\})/)?.[1];
if (n8nEvidence) evidence.n8n = JSON.parse(n8nEvidence);

heading("Zapier, every action against the real API");
const zapier = join(ROOT, "integrations/zapier-memdot");
const zapierEnv = join(zapier, ".env");
const hadEnv = existsSync(zapierEnv);
const keptEnv = hadEnv ? await readFile(zapierEnv, "utf8") : "";
await writeFile(zapierEnv, `authData_apiKey=${plainKey}\nauthData_apiUrl=${api}\n`, {
  mode: 0o600,
});
const invoke = async (...args) => {
  const result = await run("npx", ["zapier-platform", "invoke", ...args, "--non-interactive"], {
    cwd: zapier,
  });
  const start = result.stdout.search(/^[[{]/m);
  let json = null;
  if (start >= 0) {
    try {
      json = JSON.parse(result.stdout.slice(start));
    } catch {
      // Not JSON: the check below shows what it said.
    }
  }
  return { ...result, json };
};
try {
  const person = `zapier-${Date.now().toString(36)}`;
  const input = (fields) => JSON.stringify({ namespace_id: namespace, ...fields });
  check("the connection test passes", (await invoke("auth", "test")).ok);
  const added = await invoke(
    "create",
    "add_memory",
    "-i",
    input({
      text: "Tomas restocks the kiln clay every second Monday",
      user_id: person,
      infer: "false",
    }),
  );
  check("Add Memory saves it", added.json?.memory_count === 1, added.output);
  const found = await invoke(
    "search",
    "search_memories",
    "-i",
    input({ query: "when is clay restocked?", user_id: person }),
  );
  const id = found.json?.[0]?.id;
  check("Search Memories finds it by meaning", Boolean(id), found.output);
  const polled = await invoke("trigger", "new_memory", "-i", input({ user_id: person }));
  check("New Memory sees it", polled.json?.[0]?.id === id, polled.output);
  const updated = await invoke(
    "create",
    "update_memory",
    "-i",
    JSON.stringify({ id, text: "Tomas restocks the kiln clay every third Monday" }),
  );
  check(
    "Update Memory corrects it",
    updated.json?.memory?.includes("third") === true,
    updated.output,
  );
  const got = await invoke("search", "get_memory", "-i", JSON.stringify({ id }));
  check(
    "Find Memory by ID reads it",
    got.json?.[0]?.memory?.includes("third") === true,
    got.output,
  );
  const removed = await invoke("create", "delete_memory", "-i", JSON.stringify({ id }));
  check("Delete Memory forgets it", removed.json?.deleted === true, removed.output);
  const gone = await invoke("search", "get_memory", "-i", JSON.stringify({ id }));
  check("and then there's nothing to find", gone.json?.length === 0, gone.output);
} finally {
  if (hadEnv) await writeFile(zapierEnv, keptEnv, { mode: 0o600 });
  else await rm(zapierEnv, { force: true });
}

heading("Skills, from GitHub");
const sandbox = join(home, "skills-home");
const project = join(home, "skills-project");
await mkdir(sandbox);
await mkdir(project);
await run("git", ["init", "-q"], { cwd: project });
const skillsEnv = { HOME: sandbox, DISABLE_TELEMETRY: "1", CI: "1" };
const listed = await run("npx", ["-y", SKILLS_CLI, "add", "Blockchain-Oracle/memdot", "--list"], {
  cwd: project,
  env: skillsEnv,
});
const plain = listed.output.replace(
  new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[a-zA-Z]`, "g"),
  "",
);
check(
  `it offers these ${EXPECTED_SKILLS}, and no others`,
  plain.includes(`Found ${EXPECTED_SKILLS} skills`),
  plain,
);
const added = await run(
  "npx",
  ["-y", SKILLS_CLI, "add", "Blockchain-Oracle/memdot", "--all", "-y"],
  { cwd: project, env: skillsEnv },
);
check(
  "and they install",
  added.ok &&
    existsSync(join(project, ".agents/skills/memdot/SKILL.md")) &&
    existsSync(join(project, ".agents/skills/memdot-cli/references/commands.md")),
  added.output,
);

await rm(home, { recursive: true, force: true });
if (failures) {
  console.log(`\n${failures} checks failed.`);
  process.exit(1);
}
const day = evidence.at.slice(0, 10);
const out = new URL(`../docs/evidence/s12-integrations-${day}.json`, import.meta.url);
await writeFile(out, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`\nEverything held. Wrote docs/evidence/s12-integrations-${day}.json`);
