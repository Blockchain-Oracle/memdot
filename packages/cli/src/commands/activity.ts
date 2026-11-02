import type { Command } from "commander";
import { confirmDestructive, connect, parseInteger } from "../context.js";
import { CliError, dim, EXIT, emit, say } from "../output.js";

const DEFAULT_LIMIT = 50;
const ROLES = ["read_only", "read_write", "management"] as const;

export function entityCommands(program: Command): void {
  const entity = program
    .command("entity")
    .description("The users, agents and runs memories are about");

  entity
    .command("ls")
    .description("List them, with how many memories each has")
    .action(async (_options, command: Command) => {
      const { memdot, resolved } = await connect(command);
      const entities = await memdot.memories.entities(
        resolved.namespaceId ? { namespaceId: resolved.namespaceId } : {},
      );
      emit({
        count: entities.length,
        data: entities.map((row) => ({
          id: row.id,
          type: row.type,
          total_memories: row.totalMemories,
          updated_at: row.updatedAt,
        })),
        table: {
          rows: entities,
          columns: [
            { header: "Type", value: (row) => row.type },
            { header: "ID", value: (row) => row.id, max: 40 },
            { header: "Memories", value: (row) => String(row.totalMemories) },
            { header: "Updated", value: (row) => row.updatedAt.slice(0, 10) },
          ],
        },
      });
    });

  entity
    .command("rm")
    .description("Forget one and all its memories")
    .argument("<type>", "user, agent or run")
    .argument("<id>")
    .option("--dry-run", "say what would go, and change nothing")
    .option("--force", "don't ask")
    .action(async (type: string, id: string, options, command: Command) => {
      if (type !== "user" && type !== "agent" && type !== "run") {
        throw new CliError("The type is user, agent or run.", EXIT.usage, "BAD_TYPE");
      }
      const { memdot, resolved } = await connect(command);
      const namespace = resolved.namespaceId ? { namespaceId: resolved.namespaceId } : {};
      if (options.dryRun) {
        const entities = await memdot.memories.entities(namespace);
        const found = entities.find((row) => row.type === type && row.id === id);
        emit({
          data: { dry_run: true, would_delete: found?.totalMemories ?? 0 },
          text: () =>
            console.log(`Would forget ${found?.totalMemories ?? 0} memories.\nNothing changed.`),
        });
        return;
      }
      await confirmDestructive(`Forget ${type} ${id} and all its memories?`, options.force);
      const deleted = await memdot.memories.deleteEntity(type, id, namespace);
      emit({ data: deleted, text: () => console.log("Forgotten.") });
    });
}

export function eventCommands(program: Command): void {
  const event = program.command("event").description("Memory operations");

  event
    .command("ls")
    .description("Recent writes, and whether each finished")
    .option("--limit <n>", "how many", parseInteger, DEFAULT_LIMIT)
    .action(async (options, command: Command) => {
      const { memdot } = await connect(command);
      const { results } = await memdot.memories.events({ limit: options.limit });
      emit({
        count: results.length,
        data: results,
        table: {
          rows: results,
          columns: [
            { header: "ID", value: (row) => row.id },
            { header: "Status", value: (row) => row.status },
            { header: "Created", value: (row) => row.created_at.slice(0, 19) },
          ],
        },
      });
    });

  event
    .command("get")
    .description("One operation: whether it's indexed, and on the chain")
    .argument("<id>")
    .action(async (id: string, _options, command: Command) => {
      const { memdot } = await connect(command);
      emit({ data: await memdot.memories.event(id) });
    });

  const job = program.command("job").description("Storage jobs");

  job
    .command("ls")
    .description("Recent jobs")
    .option("--status <status>")
    .option("--limit <n>", "how many", parseInteger, DEFAULT_LIMIT)
    .action(async (options, command: Command) => {
      const { memdot } = await connect(command);
      const { items } = await memdot.jobs.list({
        limit: options.limit,
        ...(options.status ? { status: options.status } : {}),
      });
      emit({
        count: items.length,
        data: items,
        table: {
          rows: items,
          columns: [
            { header: "ID", value: (row) => row.id },
            { header: "Kind", value: (row) => row.kind },
            { header: "Status", value: (row) => row.status },
            { header: "Block", value: (row) => String(row.block ?? "") },
          ],
        },
      });
    });

  job
    .command("get")
    .description("One job")
    .argument("<id>")
    .action(async (id: string, _options, command: Command) => {
      const { memdot } = await connect(command);
      emit({ data: await memdot.jobs.get(id) });
    });

  job
    .command("wait")
    .description("Wait until a job finishes")
    .argument("<id>")
    .action(async (id: string, _options, command: Command) => {
      const { memdot } = await connect(command);
      emit({
        data: await memdot.jobs.waitFor(id, { onUpdate: (update) => say(dim(update.status)) }),
      });
    });
}

export function agentCommands(program: Command): void {
  const agents = program
    .command("agents")
    .description("Connected agents; managing them takes an account-wide management key");

  agents
    .command("ls")
    .description("List connected agents")
    .action(async (_options, command: Command) => {
      const { memdot } = await connect(command);
      const rows = await memdot.agents.list();
      emit({
        count: rows.length,
        data: rows.map((row) => ({
          id: row.id,
          label: row.label,
          client: row.client,
          kind: row.kind,
          role: row.role,
          space_ids: row.spaceIds,
          last_used_at: row.lastUsedAt,
          revoked_at: row.revokedAt,
        })),
        table: {
          rows,
          columns: [
            { header: "ID", value: (row) => row.id },
            { header: "Label", value: (row) => row.label, max: 32 },
            { header: "Kind", value: (row) => row.kind },
            { header: "Access", value: (row) => row.role ?? "" },
            { header: "Last used", value: (row) => row.lastUsedAt?.slice(0, 19) ?? "never" },
            { header: "State", value: (row) => (row.revokedAt ? "revoked" : "active") },
          ],
        },
      });
    });

  agents
    .command("rename")
    .description("Rename a connected agent")
    .argument("<id>")
    .argument("<label>")
    .action(async (id: string, label: string, _options, command: Command) => {
      const { memdot } = await connect(command);
      emit({ data: await memdot.agents.rename(id, label), text: () => console.log("Renamed.") });
    });

  agents
    .command("revoke")
    .description("Stop an agent now: its keys and tokens stop working, and its spaces change key")
    .argument("<id>")
    .option("--force", "don't ask")
    .action(async (id: string, options, command: Command) => {
      const { memdot } = await connect(command);
      const agent = (await memdot.agents.list()).find((row) => row.id === id);
      if (!agent) throw new CliError("No such agent.", EXIT.notFound, "NOT_FOUND");
      await confirmDestructive(`Revoke ${agent.label}?`, options.force);
      const revoked = await memdot.agents.revoke(agent);
      emit({ data: revoked, text: () => console.log(`Revoked ${agent.label}.`) });
    });
}

export function keyCommands(program: Command): void {
  const keys = program
    .command("keys")
    .description("API keys; managing them takes an account-wide management key");

  keys
    .command("ls")
    .description("List API keys")
    .action(async (_options, command: Command) => {
      const { memdot } = await connect(command);
      const { items } = await memdot.keys.list();
      emit({
        count: items.length,
        data: items,
        table: {
          rows: items,
          columns: [
            { header: "ID", value: (row) => row.id },
            { header: "Name", value: (row) => row.name ?? "", max: 32 },
            { header: "Role", value: (row) => row.role },
            { header: "Starts", value: (row) => row.start ?? "" },
            { header: "Last used", value: (row) => row.lastUsedAt?.slice(0, 19) ?? "never" },
          ],
        },
      });
    });

  keys
    .command("create")
    .description("Make a key. It's shown once, here")
    .argument("<name>")
    .option("--role <role>", ROLES.join(", "), "read_write")
    .option("--space <id...>", "limit it to these spaces")
    .option("--expires-days <n>", "stop working after this many days", parseInteger)
    .action(async (name: string, options, command: Command) => {
      if (!ROLES.includes(options.role)) {
        throw new CliError(`--role is one of ${ROLES.join(", ")}.`, EXIT.usage, "BAD_ROLE");
      }
      const { memdot } = await connect(command);
      const created = await memdot.keys.create({
        name,
        role: options.role,
        ...(options.space ? { spaceIds: options.space } : {}),
        ...(options.expiresDays ? { expiresInDays: options.expiresDays } : {}),
      });
      emit({
        data: { id: created.id, name: created.name, role: created.role, key: created.key },
        text: () => {
          console.log(created.key);
          say(dim("Shown once: store it now."));
        },
      });
    });

  keys
    .command("rotate")
    .description("Revoke a key and make a new one with the same name, role and spaces")
    .argument("<id>")
    .option("--force", "don't ask")
    .action(async (id: string, options, command: Command) => {
      const { memdot } = await connect(command);
      await confirmDestructive(`Rotate ${id}? The old key stops working at once.`, options.force);
      const created = await memdot.keys.rotate(id);
      emit({
        data: { id: created.id, name: created.name, role: created.role, key: created.key },
        text: () => {
          console.log(created.key);
          say(dim("Shown once: store it now."));
        },
      });
    });

  keys
    .command("revoke")
    .description("Revoke a key")
    .argument("<id>")
    .option("--force", "don't ask")
    .action(async (id: string, options, command: Command) => {
      const { memdot } = await connect(command);
      await confirmDestructive(`Revoke ${id}?`, options.force);
      await memdot.keys.revoke(id);
      emit({ data: { id, revoked: true }, text: () => console.log("Revoked.") });
    });
}

export function usageCommands(program: Command): void {
  program
    .command("usage")
    .description("Storage, renewals and shared-model allowance")
    .action(async (_options, command: Command) => {
      const { memdot } = await connect(command);
      emit({ data: await memdot.usage() });
    });

  program
    .command("logs")
    .description("Recent API requests: metadata only, never bodies")
    .option("--limit <n>", "how many", parseInteger, DEFAULT_LIMIT)
    .action(async (options, command: Command) => {
      const { memdot } = await connect(command);
      const { items } = await memdot.activity.requests({ limit: options.limit });
      emit({
        count: items.length,
        data: items,
        table: {
          rows: items,
          columns: [
            { header: "When", value: (row) => row.createdAt.slice(0, 19) },
            { header: "Method", value: (row) => row.method },
            { header: "Path", value: (row) => row.path, max: 48 },
            { header: "Status", value: (row) => String(row.status) },
            { header: "ms", value: (row) => String(row.latencyMs) },
            { header: "Client", value: (row) => row.client ?? "", max: 24 },
          ],
        },
      });
    });
}
