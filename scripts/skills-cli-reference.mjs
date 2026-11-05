// Writes the memdot-cli skill's command list from the CLI's own description of itself, so it can't
// drift. Usage: node scripts/skills-cli-reference.mjs [--check]

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const CLI = new URL("../packages/cli/dist/index.mjs", import.meta.url).pathname;
const OUT = new URL("../skills/memdot-cli/references/commands.md", import.meta.url);

const root = JSON.parse(
  execFileSync("node", [CLI, "help", "--json"], {
    encoding: "utf8",
    env: {
      ...process.env,
      MEMDOT_API_KEY: "",
      MEMDOT_CREDENTIALS_DIR: "/nonexistent-memdot-reference",
    },
  }),
);
const table = (cell) =>
  String(cell ?? "")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ");
const lines = [
  "# Every memdot command",
  "",
  "Generated from `memdot help --json` by `scripts/skills-cli-reference.mjs`. Don't edit by hand.",
  "",
];

// `help --json` already gives a subcommand its whole name, "file put".
function usage(command) {
  const args = (command.arguments ?? []).map((arg) =>
    arg.required ? `<${arg.name}>` : `[${arg.name}]`,
  );
  return ["memdot", command.name, ...args].join(" ");
}

function write(command, depth) {
  if (depth > 0) {
    lines.push(`${"#".repeat(Math.min(depth + 1, 4))} \`${usage(command)}\``, "");
    if (command.description) lines.push(table(command.description), "");
    const options = (command.options ?? []).filter((option) => option.flags !== "-h, --help");
    if (options.length) {
      lines.push("| Option | What it does |", "|---|---|");
      for (const option of options) {
        lines.push(`| \`${table(option.flags)}\` | ${table(option.description)} |`);
      }
      lines.push("");
    }
  }
  for (const sub of command.subcommands ?? []) {
    if (sub.name === "help" || sub.name.endsWith(" help")) continue;
    write(sub, depth + 1);
  }
}

lines.push("## Options on every command", "", "| Option | What it does |", "|---|---|");
for (const option of root.options ?? []) {
  if (option.flags === "-h, --help") continue;
  lines.push(`| \`${table(option.flags)}\` | ${table(option.description)} |`);
}
lines.push("");
write(root, 0);
const text = `${lines.join("\n").trimEnd()}\n`;

if (process.argv.includes("--check")) {
  if (readFileSync(OUT, "utf8") !== text) {
    console.error(
      "skills/memdot-cli/references/commands.md is out of date. Run: node scripts/skills-cli-reference.mjs",
    );
    process.exit(1);
  }
} else {
  writeFileSync(OUT, text);
}
