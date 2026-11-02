#!/usr/bin/env node
import { Command, CommanderError, Option } from "commander";
import {
  agentCommands,
  entityCommands,
  eventCommands,
  keyCommands,
  usageCommands,
} from "./commands/activity.js";
import { mcpCommands } from "./commands/mcp.js";
import { memoryCommands } from "./commands/memory.js";
import { setupCommands } from "./commands/setup.js";
import { fileCommands, spaceCommands } from "./commands/storage.js";
import { VERSION } from "./context.js";
import {
  CliError,
  EXIT,
  emit,
  OUTPUT_MODES,
  type OutputMode,
  reportError,
  setOutput,
} from "./output.js";

/** These can't be undone; a script or agent needs --force for them. */
const DESTRUCTIVE = new Set([
  "delete",
  "file rm",
  "file revoke",
  "space rm",
  "folder rm",
  "entity rm",
  "agents revoke",
  "keys rotate",
  "keys revoke",
]);
/** Commands that default to a table for people. */
const TABLE_FIRST = new Set([
  "list",
  "file ls",
  "space ls",
  "folder ls",
  "namespace ls",
  "entity ls",
  "event ls",
  "job ls",
  "agents ls",
  "keys ls",
  "logs",
  "history",
  "file versions",
]);

const fullName = (command: Command): string => {
  const names: string[] = [];
  for (let at: Command | null = command; at?.parent; at = at.parent) names.unshift(at.name());
  return names.join(" ");
};

/** The command tree, read from the commands themselves, so it can't drift from them. */
function describe(command: Command): Record<string, unknown> {
  const name = fullName(command);
  const sub = command.commands.filter((child) => child.name() !== "help");
  return {
    name: name || command.name(),
    description: command.description(),
    ...(DESTRUCTIVE.has(name) ? { destructive: true, confirm_flag: "--force" } : {}),
    arguments: command.registeredArguments.map((argument) => ({
      name: argument.name(),
      required: argument.required,
      description: argument.description,
    })),
    options: command.options
      .filter((option) => !option.hidden)
      .map((option) => ({
        flags: option.flags,
        description: option.description,
        ...(option.defaultValue !== undefined ? { default: option.defaultValue } : {}),
        ...(option.argChoices ? { choices: option.argChoices } : {}),
        ...(option.envVar ? { env: option.envVar } : {}),
      })),
    ...(sub.length ? { subcommands: sub.map(describe) } : {}),
  };
}

function modeFor(options: { agent?: boolean; json?: boolean; output?: OutputMode }, name: string) {
  if (options.agent || options.json) return "json" as const;
  return options.output ?? (TABLE_FIRST.has(name) ? ("table" as const) : ("text" as const));
}

const program = new Command();
program
  .name("memdot")
  .description("Encrypted storage and agent memory on Portaldot V3.")
  .version(VERSION, "-v, --version", "this CLI's version")
  .showHelpAfterError(false)
  .exitOverride()
  .addOption(new Option("--agent", "answer as one JSON envelope on stdout, for agents and scripts"))
  .addOption(new Option("--json", "the same as --agent"))
  .addOption(
    new Option("-o, --output <mode>", "how to answer").choices(OUTPUT_MODES).env("MEMDOT_OUTPUT"),
  )
  // These also read MEMDOT_API_KEY and so on, later: a flag beats the environment beats the file.
  .option("--api-key <key>", "use this key (or MEMDOT_API_KEY)")
  .option("--api-url <url>", "use this API (or MEMDOT_API_URL)")
  .option("-n, --namespace <id>", "which namespace (or MEMDOT_NAMESPACE)")
  .option("-u, --user-id <id>", "who this is about (or MEMDOT_USER_ID)")
  .option("--agent-id <id>", "which agent this belongs to (or MEMDOT_AGENT_ID)")
  .option("--run-id <id>", "which session or run (or MEMDOT_RUN_ID)")
  .hook("preAction", (_root, action) => {
    const name = fullName(action);
    setOutput(modeFor(program.opts(), name), name);
  });

program.configureOutput({
  // Usage errors are reported once, below, in the shape this run expects.
  writeErr: () => undefined,
});
program.addHelpCommand(false);

memoryCommands(program);
fileCommands(program);
spaceCommands(program);
entityCommands(program);
eventCommands(program);
agentCommands(program);
keyCommands(program);
usageCommands(program);
setupCommands(program);
mcpCommands(program);

program
  .command("help")
  .description("Show the commands; --json for all of them, for an agent to read")
  .argument("[command...]", "a command to explain")
  .option("--json", "the whole tree as JSON")
  .action((names: string[], options) => {
    if (options.json || program.opts().json || program.opts().agent) {
      console.log(
        JSON.stringify(
          {
            exit_codes: EXIT,
            envelope: {
              success: { status: "success", command: "", duration_ms: 0, count: 0, data: {} },
              error: { status: "error", command: "", error: { code: "", message: "" }, data: null },
            },
            ...describe(program),
          },
          null,
          2,
        ),
      );
      return;
    }
    let at: Command = program;
    for (const name of names) {
      const next = at.commands.find((child) => child.name() === name);
      if (!next)
        throw new CliError(`No such command: ${names.join(" ")}`, EXIT.usage, "NO_COMMAND");
      at = next;
    }
    at.outputHelp();
  });

function leave(code: number): never {
  // The chain connection and open sockets shouldn't hold the process open once it has answered.
  process.exit(code);
}

// Anything long-running (the MCP server) never returns from its action, so this only runs for
// commands that have finished.
try {
  // Before a subcommand is chosen, a usage error still has to come back as JSON if asked for.
  const raw = process.argv.slice(2);
  if (raw.includes("--agent") || raw.includes("--json")) setOutput("json", raw[0] ?? "memdot");
  await program.parseAsync(process.argv);
  const running = program.args[0] === "mcp" && program.args[1] !== "config";
  if (!running) leave(typeof process.exitCode === "number" ? process.exitCode : EXIT.ok);
} catch (error) {
  if (error instanceof CommanderError) {
    if (error.exitCode === 0) leave(EXIT.ok);
    leave(reportError(new CliError(error.message.replace(/^error: /, ""), EXIT.usage, "USAGE")));
  }
  if (error instanceof CliError && error.code === "CANCELLED") {
    emit({ data: { cancelled: true }, text: () => console.log("Cancelled.") });
    leave(EXIT.ok);
  }
  leave(reportError(error));
}
