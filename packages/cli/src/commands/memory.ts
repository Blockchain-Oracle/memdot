import { writeFile } from "node:fs/promises";
import type { Memory, ScoredMemory } from "@memdot/sdk";
import type { Command } from "commander";
import {
  confirmDestructive,
  connect,
  namedScope,
  parseFraction,
  parseInteger,
  parseJson,
  readStdin,
  readText,
  scopeFilter,
  scopeOf,
} from "../context.js";
import { CliError, type Column, dim, EXIT, emit, good, say, strong } from "../output.js";

const DEFAULT_TOP_K = 10;
const PAGE_SIZE = 100;
const ID_WIDTH = 8;

const memoryOut = (memory: Memory | ScoredMemory) => ({
  id: memory.id,
  memory: memory.memory,
  ...("score" in memory ? { score: Math.round(memory.score * 1000) / 1000 } : {}),
  user_id: memory.userId,
  agent_id: memory.agentId,
  run_id: memory.runId,
  categories: memory.categories,
  metadata: memory.metadata,
  namespace_id: memory.namespaceId,
  created_at: memory.createdAt,
  expiration_date: memory.expirationDate,
});

const COLUMNS: Column<Memory>[] = [
  { header: "ID", value: (m) => m.id },
  { header: "Memory", value: (m) => m.memory, max: 60 },
  { header: "User", value: (m) => m.userId ?? "" },
  { header: "Created", value: (m) => m.createdAt.slice(0, 10) },
];

function printMemories(memories: (Memory | ScoredMemory)[]): void {
  if (memories.length === 0) {
    console.log("Nothing found.");
    return;
  }
  memories.forEach((memory, i) => {
    console.log(`${i + 1}. ${memory.memory}`);
    const score = "score" in memory ? `Score ${memory.score.toFixed(2)} · ` : "";
    console.log(
      dim(
        `   ${score}${memory.id.slice(0, ID_WIDTH)} · ${memory.createdAt.slice(0, 10)}${memory.userId ? ` · ${memory.userId}` : ""}`,
      ),
    );
  });
}

const untilDayEnds = (value: string): string => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new CliError("--expires takes YYYY-MM-DD.", EXIT.usage, "BAD_DATE");
  }
  return value;
};

/** Combines the scope with --filter, so `-u priya --filter ...` narrows by both. */
function filtersFrom(
  command: Command,
  raw: string | undefined,
  extra: Record<string, unknown>[] = [],
): Record<string, unknown> | undefined {
  const parts = [
    ...scopeFilter(namedScope(command)),
    ...extra,
    ...(raw ? [parseJson<Record<string, unknown>>(raw, "--filter")] : []),
  ];
  if (parts.length === 0) return undefined;
  return parts.length === 1 ? parts[0] : { AND: parts };
}

export function memoryCommands(program: Command): void {
  program
    .command("add")
    .description("Remember something")
    .argument("[text]", "what to remember; or pipe it in")
    .option("--messages <json>", "a conversation, as a JSON array of {role, content}")
    .option("-f, --file <path>", "read the conversation from a JSON file")
    .option("-m, --metadata <json>", "metadata to keep with it")
    .option("--no-infer", "store it exactly as written, without a model")
    .option("--procedural", "keep this as an agent's working record")
    .option("--immutable", "never let it change")
    .option("--expires <date>", "when it stops counting (YYYY-MM-DD)")
    .option("--timestamp <time>", "when it happened (ISO time or unix seconds)")
    .option("--prompt <text>", "custom instructions, for this call only")
    .option(
      "--categories <json>",
      "categories to file under, as a JSON array of {name, description}",
    )
    .option("--idempotency-key <key>", "sent again with the same key, it isn't saved twice")
    .option("--wait-chain", "wait until it's finalized on Portaldot V3")
    .option("--no-wait", "return at once with an event to follow")
    .action(async (text: string | undefined, options, command: Command) => {
      const { memdot, resolved } = await connect(command);
      const content: string | { role: "user" | "assistant" | "system"; content: string }[] =
        options.file
          ? parseJson(await readText(options.file), "--file")
          : options.messages
            ? parseJson(options.messages, "--messages")
            : (text ?? (await readStdin()) ?? "");
      if (!content || content.length === 0) {
        throw new CliError("Say what to remember, or pipe it in.", EXIT.usage, "EMPTY");
      }
      const added = await memdot.memories.add(content, {
        ...scopeOf(command, resolved),
        ...(resolved.namespaceId ? { namespaceId: resolved.namespaceId } : {}),
        ...(options.metadata ? { metadata: parseJson(options.metadata, "--metadata") } : {}),
        infer: options.infer !== false,
        ...(options.procedural ? { memoryType: "procedural_memory" as const } : {}),
        ...(options.immutable ? { immutable: true } : {}),
        ...(options.expires ? { expirationDate: untilDayEnds(options.expires) } : {}),
        ...(options.timestamp ? { timestamp: options.timestamp } : {}),
        ...(options.prompt ? { prompt: options.prompt } : {}),
        ...(options.categories
          ? { categories: parseJson(options.categories, "--categories") }
          : {}),
        ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
        wait: options.wait === false ? false : options.waitChain ? "chain" : "indexed",
      });
      emit({
        count: added.results.length,
        scope: scopeOf(command, resolved),
        data: {
          event_id: added.eventId,
          status: added.status,
          namespace_id: added.namespaceId,
          results: added.results.map((result) => ({
            id: result.id,
            memory: result.memory,
            event: result.event,
          })),
          duplicates: added.duplicates,
          note: added.note,
        },
        text: () => {
          if (added.results.length === 0 && added.eventId) {
            console.log(`Queued. Follow it with: memdot event get ${added.eventId}`);
          } else if (added.results.length === 0) {
            console.log("Nothing new: that's already remembered.");
          }
          for (const result of added.results) {
            console.log(`${good("+")} ${result.memory}  ${dim(result.id.slice(0, ID_WIDTH))}`);
          }
          if (added.duplicates) console.log(dim(`${added.duplicates} already remembered`));
          if (added.note) console.log(dim(added.note));
        },
      });
    });

  program
    .command("search")
    .description("Find what's been remembered, by meaning and keyword")
    .argument("[query]", "what to look for; or pipe it in")
    .option("-k, --top-k <n>", "how many results", parseInteger, DEFAULT_TOP_K)
    .option("--threshold <n>", "minimum similarity, 0 to 1", parseFraction)
    .option("--keyword", "match words only")
    .option("--semantic", "match meaning only")
    .option("--rerank", "let the model put the best first")
    .option("--filter <json>", 'for example {"AND":[{"user_id":"priya"}]}')
    .option("--show-expired", "include what has expired")
    .option("--reference-date <date>", "search as of this moment")
    .option("--fields <list>", "only these fields, comma separated")
    .action(async (query: string | undefined, options, command: Command) => {
      const { memdot, resolved } = await connect(command);
      const text = query ?? (await readStdin());
      if (!text) throw new CliError("Say what to search for.", EXIT.usage, "EMPTY");
      const filters = filtersFrom(command, options.filter);
      const results = await memdot.memories.search(text, {
        topK: options.topK,
        ...(resolved.namespaceId ? { namespaceId: resolved.namespaceId } : {}),
        ...(filters ? { filters } : {}),
        ...(options.threshold !== undefined ? { threshold: options.threshold } : {}),
        ...(options.keyword ? { mode: "keyword" as const } : {}),
        ...(options.semantic ? { mode: "semantic" as const } : {}),
        ...(options.rerank ? { rerank: true } : {}),
        ...(options.showExpired ? { showExpired: true } : {}),
        ...(options.referenceDate ? { referenceDate: options.referenceDate } : {}),
      });
      const fields: string[] | null = options.fields ? options.fields.split(",") : null;
      emit({
        count: results.length,
        scope: namedScope(command),
        data: results.map((memory) => {
          const out = memoryOut(memory);
          return fields
            ? Object.fromEntries(Object.entries(out).filter(([key]) => fields.includes(key)))
            : out;
        }),
        text: () => printMemories(results),
        table: {
          rows: results as Memory[],
          columns: [
            COLUMNS[0] as Column<Memory>,
            { header: "Score", value: (m) => (m as ScoredMemory).score.toFixed(2) },
            ...COLUMNS.slice(1),
          ],
        },
      });
    });

  program
    .command("list")
    .description("List memories, newest first")
    .option("--page-size <n>", "how many at a time", parseInteger, PAGE_SIZE)
    .option("--cursor <cursor>", "next_cursor from the page before")
    .option("--category <name>", "only this category")
    .option("--after <date>", "created after this date")
    .option("--before <date>", "created before this date")
    .option("--filter <json>", 'for example {"user_id":"priya"}')
    .option("--show-expired", "include what has expired")
    .action(async (options, command: Command) => {
      const { memdot, resolved } = await connect(command);
      const filters = filtersFrom(command, options.filter, [
        ...(options.category ? [{ categories: { in: [options.category] } }] : []),
        ...(options.after ? [{ created_at: { gte: options.after } }] : []),
        ...(options.before ? [{ created_at: { lte: options.before } }] : []),
      ]);
      const page = await memdot.memories.list({
        pageSize: options.pageSize,
        ...(resolved.namespaceId ? { namespaceId: resolved.namespaceId } : {}),
        ...(filters ? { filters } : {}),
        ...(options.cursor ? { cursor: options.cursor } : {}),
        ...(options.showExpired ? { showExpired: true } : {}),
      });
      emit({
        count: page.results.length,
        scope: namedScope(command),
        data: { results: page.results.map(memoryOut), next_cursor: page.nextCursor },
        table: { rows: page.results, columns: COLUMNS },
      });
    });

  program
    .command("get")
    .description("Read one memory")
    .argument("<id>")
    .action(async (id: string, _options, command: Command) => {
      const { memdot } = await connect(command);
      const memory = await memdot.memories.get(id);
      emit({
        data: {
          ...memoryOut(memory),
          version: memory.version,
          updated_at: memory.updatedAt,
          segment: memory.segment,
          source: memory.source,
        },
        text: () => {
          console.log(strong(memory.memory));
          console.log(dim(`${memory.id} · v${memory.version} · ${memory.createdAt}`));
          if (memory.segment?.cid) console.log(dim(`On Portaldot V3: ${memory.segment.cid}`));
        },
      });
    });

  program
    .command("update")
    .description("Correct a memory; the old version stays in its history")
    .argument("<id>")
    .argument("[text]", "what it should say; or pipe it in")
    .option("-m, --metadata <json>", "metadata to merge in")
    .option("--expires <date>", "when it stops counting (YYYY-MM-DD)")
    .action(async (id: string, text: string | undefined, options, command: Command) => {
      const { memdot } = await connect(command);
      const body = text ?? (await readStdin());
      if (!body && !options.metadata && !options.expires) {
        throw new CliError("Say what should change.", EXIT.usage, "EMPTY");
      }
      const memory = await memdot.memories.update(id, {
        ...(body ? { text: body } : {}),
        ...(options.metadata ? { metadata: parseJson(options.metadata, "--metadata") } : {}),
        ...(options.expires ? { expirationDate: untilDayEnds(options.expires) } : {}),
      });
      emit({
        data: memoryOut(memory),
        text: () => console.log(`${good("~")} ${memory.memory}`),
      });
    });

  program
    .command("delete")
    .description("Forget a memory, or everything in a scope")
    .argument("[id]")
    .option("--all", "everything in the given scope (-u, --agent-id or --run-id)")
    .option("--dry-run", "say what would go, and change nothing")
    .option("--force", "don't ask")
    .action(async (id: string | undefined, options, command: Command) => {
      if (Boolean(id) === Boolean(options.all)) {
        throw new CliError("Give a memory id, or --all with a scope.", EXIT.usage, "BAD_ARGS");
      }
      const { memdot, resolved } = await connect(command);
      if (id) {
        const memory = await memdot.memories.get(id);
        if (options.dryRun) {
          emit({
            count: 1,
            data: { dry_run: true, would_delete: 1, memories: [memoryOut(memory)] },
            text: () => console.log(`Would forget: ${memory.memory}\nNothing changed.`),
          });
          return;
        }
        await confirmDestructive(`Forget "${memory.memory}"?`, options.force);
        await memdot.memories.delete(id);
        emit({
          count: 1,
          data: { id, deleted: true },
          text: () => console.log(`Forgotten: ${memory.memory}`),
        });
        return;
      }

      const scope = namedScope(command);
      if (Object.keys(scope).length === 0) {
        throw new CliError(
          "Name a scope with -u, --agent-id or --run-id: this won't forget a whole namespace.",
          EXIT.usage,
          "SCOPE_REQUIRED",
        );
      }
      const namespace = resolved.namespaceId ? { namespaceId: resolved.namespaceId } : {};
      const filters = filtersFrom(command, undefined);
      if (options.dryRun) {
        let total = 0;
        let cursor: string | undefined;
        do {
          const page = await memdot.memories.list({
            ...namespace,
            pageSize: PAGE_SIZE,
            ...(filters ? { filters } : {}),
            ...(cursor ? { cursor } : {}),
          });
          total += page.results.length;
          cursor = page.nextCursor ?? undefined;
        } while (cursor);
        emit({
          count: total,
          scope,
          data: { dry_run: true, would_delete: total },
          text: () => console.log(`Would forget ${total} memories.\nNothing changed.`),
        });
        return;
      }
      await confirmDestructive(`Forget everything for ${JSON.stringify(scope)}?`, options.force);
      const { deleted } = await memdot.memories.deleteAll({ ...scope, ...namespace });
      emit({
        count: deleted,
        scope,
        data: { deleted },
        text: () => console.log(`Forgot ${deleted} memories.`),
      });
    });

  program
    .command("history")
    .description("How a memory changed")
    .argument("<id>")
    .action(async (id: string, _options, command: Command) => {
      const { memdot } = await connect(command);
      const history = await memdot.memories.history(id);
      emit({
        count: history.length,
        data: history.map((event) => ({
          event: event.event,
          old_memory: event.oldMemory,
          new_memory: event.newMemory,
          actor: event.actor,
          created_at: event.createdAt,
        })),
        table: {
          rows: history,
          columns: [
            { header: "When", value: (event) => event.createdAt.slice(0, 19) },
            { header: "Event", value: (event) => event.event },
            {
              header: "Memory",
              value: (event) => event.newMemory ?? event.oldMemory ?? "",
              max: 70,
            },
          ],
        },
      });
    });

  program
    .command("import")
    .description("Bring memories in from a MemDot or Mem0 export")
    .argument("<file>", "a JSON file")
    .option("--source <name>", "where these came from", "cli")
    .action(async (file: string, options, command: Command) => {
      const { memdot, resolved } = await connect(command);
      const namespaceId = resolved.namespaceId;
      if (!namespaceId) {
        throw new CliError("Name a namespace with --namespace.", EXIT.usage, "NAMESPACE_REQUIRED");
      }
      const items = parseJson<unknown>(await readText(file), "That file");
      say(dim("Importing…"));
      const report = await memdot.memories.importMemories(items, {
        source: options.source,
        namespaceId,
      });
      emit({
        count: report.imported,
        data: {
          imported: report.imported,
          duplicates: report.duplicates,
          skipped: report.skipped,
          namespace_id: namespaceId,
        },
        text: () =>
          console.log(`Imported ${report.imported}. ${report.duplicates} were already here.`),
      });
    });

  program
    .command("export")
    .description("Write a namespace's memories out as JSON, decrypted here")
    .option("--out <file>", "where to write it (default: stdout)")
    .action(async (options, command: Command) => {
      const { memdot, resolved } = await connect(command);
      const namespaceId = resolved.namespaceId;
      if (!namespaceId) {
        throw new CliError("Name a namespace with --namespace.", EXIT.usage, "NAMESPACE_REQUIRED");
      }
      const memories = await memdot.memories.exportMemories(namespaceId);
      if (options.out) await writeFile(options.out, `${JSON.stringify(memories, null, 2)}\n`);
      emit({
        count: memories.length,
        data: options.out ? { exported: memories.length, out: options.out } : memories,
        text: () => {
          if (options.out) console.log(`Wrote ${memories.length} memories to ${options.out}.`);
          else console.log(JSON.stringify(memories, null, 2));
        },
      });
    });

  program
    .command("restore")
    .description("Rebuild a namespace's search from the chain")
    .action(async (_options, command: Command) => {
      const { memdot, resolved } = await connect(command);
      const namespaceId = resolved.namespaceId;
      if (!namespaceId) {
        throw new CliError("Name a namespace with --namespace.", EXIT.usage, "NAMESPACE_REQUIRED");
      }
      say(dim("Reading it back from Portaldot V3…"));
      const restored = await memdot.memories.restore(namespaceId);
      emit({ data: restored });
    });
}
