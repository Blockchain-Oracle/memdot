import { readFile, stat, writeFile } from "node:fs/promises";
import { basename } from "node:path";
import { formatTpot } from "@memdot/sdk";
import type { Command } from "commander";
import { confirmDestructive, connect, parseInteger, spaceOf } from "../context.js";
import { CliError, type Column, dim, EXIT, emit, good, say } from "../output.js";

const DEFAULT_PAGE = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

interface FileRow {
  id: string;
  name: string | null;
  size: number | null;
  status: string;
  cid: string | null;
}

const fileColumns: Column<FileRow>[] = [
  { header: "ID", value: (file) => file.id },
  { header: "Name", value: (file) => file.name ?? "(sealed)", max: 40 },
  { header: "Size", value: (file) => (file.size === null ? "" : String(file.size)) },
  { header: "Status", value: (file) => file.status },
  { header: "CID", value: (file) => file.cid ?? "", max: 24 },
];

const expiresAt = (days: number | undefined) =>
  days ? { expiresAt: new Date(Date.now() + days * DAY_MS).toISOString() } : {};

export function fileCommands(program: Command): void {
  const file = program.command("file").description("Encrypted files on Portaldot V3");

  file
    .command("put")
    .description("Encrypt a file here and store it")
    .argument("<path>")
    .option("--space <id>", "which space (default: the only one you can reach)")
    .option("--folder <id>", "which folder")
    .option("--name <name>", "what to call it (default: the file's own name)")
    .option("--mime <type>", "its type")
    .option("--replaces <id>", "store this as a new version of that file")
    .option("--dry-run", "say what it would cost, and store nothing")
    .option("--no-wait", "return once it's queued, before it's on chain")
    .action(async (path: string, options, command: Command) => {
      const { memdot } = await connect(command);
      const size = (await stat(path)).size;
      if (options.dryRun) {
        const estimate = memdot.files.estimate(size);
        emit({
          data: {
            dry_run: true,
            size,
            blobs: estimate.blobs,
            planck: String(estimate.planck),
            tpot: formatTpot(estimate.planck),
          },
          text: () =>
            console.log(
              `${size} bytes, ${estimate.blobs} blobs, about ${formatTpot(estimate.planck)} tPOT.\nNothing stored.`,
            ),
        });
        return;
      }
      const spaceId = await spaceOf(memdot, options.space);
      const name = options.name ?? basename(path);
      say(dim(`Encrypting ${name}…`));
      const { file: stored, job } = await memdot.files.put(await readFile(path), {
        spaceId,
        name,
        ...(options.folder ? { folderId: options.folder } : {}),
        ...(options.mime ? { mime: options.mime } : {}),
        ...(options.replaces ? { previousVersionId: options.replaces } : {}),
        wait: options.wait !== false,
        onProgress: (update) => say(dim(`  ${update.status}`)),
      });
      emit({
        data: {
          id: stored.id,
          name,
          cid: stored.cid,
          status: job.status,
          job_id: job.id,
          tx_hash: job.txHash,
          block: job.block,
        },
        text: () => {
          console.log(`${good("Stored")} ${name}  ${dim(stored.id)}`);
          if (stored.cid) console.log(dim(`CID ${stored.cid}`));
        },
      });
    });

  file
    .command("get")
    .description("Fetch a file and decrypt it here")
    .argument("<id>")
    .option("-O, --out <path>", "where to write it (default: its own name)")
    .option("--stdout", "write the bytes to stdout")
    .action(async (id: string, options, command: Command) => {
      const { memdot } = await connect(command);
      const { data, name, mime } = await memdot.files.get(id);
      if (options.stdout) {
        process.stdout.write(data);
        return;
      }
      const out = options.out ?? basename(name);
      await writeFile(out, data, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "EEXIST") {
          throw new CliError(`${out} already exists.`, EXIT.conflict, "FILE_EXISTS");
        }
        throw error;
      });
      emit({
        data: { id, name, mime, size: data.length, out },
        text: () => console.log(`Wrote ${out} (${data.length} bytes).`),
      });
    });

  file
    .command("ls")
    .description("List files, names decrypted here")
    .option("--space <id>")
    .option("--folder <id>")
    .option("--limit <n>", "how many", parseInteger, DEFAULT_PAGE)
    .option("--cursor <cursor>")
    .action(async (options, command: Command) => {
      const { memdot } = await connect(command);
      const page = await memdot.files.list({
        ...(options.space ? { spaceId: options.space } : {}),
        ...(options.folder ? { folderId: options.folder } : {}),
        limit: options.limit,
        ...(options.cursor ? { cursor: options.cursor } : {}),
      });
      emit({
        count: page.items.length,
        data: {
          next_cursor: page.nextCursor,
          files: page.items.map((row) => ({
            id: row.id,
            name: row.name,
            mime: row.mime,
            size: row.size,
            status: row.status,
            cid: row.cid,
            folder_id: row.folderId,
            created_at: row.createdAt,
          })),
        },
        table: { rows: page.items, columns: fileColumns },
      });
    });

  file
    .command("verify")
    .description("Check a file against the chain, from this machine")
    .argument("<id>")
    .action(async (id: string, _options, command: Command) => {
      const { memdot } = await connect(command);
      say(dim("Asking Portaldot V3…"));
      let result = await memdot.files.verify(id);
      // A node can stall on a cold connection; "inconclusive" means ask again.
      if (result.inconclusive) result = await memdot.files.verify(id);
      await memdot.close();
      if (!result.ok && !result.inconclusive) {
        throw new CliError("The chain doesn't match this file.", EXIT.failed, "VERIFY_FAILED");
      }
      emit({
        data: result,
        text: () =>
          console.log(
            result.ok
              ? `${good("Verified")}: ${result.blobs.length} blobs hash to their CIDs on V3.`
              : "A node didn't answer in time, so this says nothing either way. Try again.",
          ),
      });
    });

  file
    .command("share")
    .description("Share a file or a space, which takes the owner's keys")
    .argument("[id]", "a file; or use --space for a whole space")
    .option("--space <id>", "share this whole space instead")
    .option("--to <address>", "someone's Portaldot or EVM address")
    .option("--to-agent <id>", "a connected agent")
    .option("--scope <scope>", "read or read_write", "read")
    .option("--expires-days <n>", "stop working after this many days", parseInteger)
    .action(async (id: string | undefined, options, command: Command) => {
      if (Boolean(id) === Boolean(options.space)) {
        throw new CliError("Give a file id, or --space.", EXIT.usage, "BAD_ARGS");
      }
      if (Boolean(options.to) === Boolean(options.toAgent)) {
        throw new CliError("Give --to or --to-agent.", EXIT.usage, "BAD_ARGS");
      }
      const { memdot } = await connect(command);
      let to: { address: string } | { agentId: string; agentKey: string };
      if (options.toAgent) {
        const agent = (await memdot.agents.list()).find((row) => row.id === options.toAgent);
        if (!agent?.publicKey) {
          throw new CliError("That agent can't receive keys.", EXIT.notFound, "AGENT");
        }
        to = { agentId: agent.id, agentKey: agent.publicKey };
      } else {
        to = { address: options.to };
      }
      const share = { scope: options.scope, ...expiresAt(options.expiresDays) };
      const grant = options.space
        ? await memdot.sharing.shareSpace(options.space, to, share)
        : await memdot.sharing.shareFile(id as string, to, share);
      emit({
        data: { grant_id: grant.id, status: grant.status, scope: grant.scope },
        text: () =>
          console.log(
            grant.status === "pending"
              ? `Waiting: it completes once they've set up MemDot. Grant ${grant.id}`
              : `Shared. Grant ${grant.id}`,
          ),
      });
    });

  file
    .command("revoke")
    .description("Stop a share; future writes use a key they never get")
    .argument("<grantId>")
    .option("--force", "don't ask")
    .action(async (grantId: string, options, command: Command) => {
      await confirmDestructive(`Revoke grant ${grantId}?`, options.force);
      const { memdot } = await connect(command);
      await memdot.sharing.revoke(grantId);
      emit({
        data: { grant_id: grantId, revoked: true },
        text: () => console.log("Revoked. Anything they already opened may have been kept."),
      });
    });

  file
    .command("rm")
    .description("Delete a file; its bytes leave the chain within 7 days")
    .argument("<id>")
    .option("--force", "don't ask")
    .action(async (id: string, options, command: Command) => {
      const { memdot } = await connect(command);
      await confirmDestructive(`Delete ${id}? Memories learned from it go too.`, options.force);
      await memdot.files.delete(id);
      emit({ data: { id, deleted: true }, text: () => console.log("Deleted.") });
    });

  file
    .command("renew")
    .description("Renew a file now, without waiting for the keeper")
    .argument("<id>")
    .option("--no-wait", "return once it's queued")
    .action(async (id: string, options, command: Command) => {
      const { memdot } = await connect(command);
      const job = await memdot.files.renew(id, { wait: options.wait !== false });
      emit({
        data: { job_id: job.id, status: job.status, tx_hash: job.txHash, block: job.block },
        text: () => console.log(`Renewal ${job.status}.`),
      });
    });

  file
    .command("versions")
    .description("Every version of a file")
    .argument("<id>")
    .action(async (id: string, _options, command: Command) => {
      const { memdot } = await connect(command);
      const versions = await memdot.files.versions(id);
      emit({
        count: versions.length,
        data: versions.map((row) => ({
          id: row.id,
          name: row.name,
          size: row.size,
          status: row.status,
          cid: row.cid,
          created_at: row.createdAt,
        })),
        table: { rows: versions, columns: fileColumns },
      });
    });
}

export function spaceCommands(program: Command): void {
  const space = program.command("space").description("Spaces: where files and namespaces live");

  space
    .command("ls")
    .description("List the spaces this key can reach")
    .action(async (_options, command: Command) => {
      const { memdot } = await connect(command);
      const spaces = await memdot.spaces.list();
      emit({
        count: spaces.length,
        data: spaces.map((row) => ({
          id: row.id,
          name: row.name,
          mode: row.mode,
          used_bytes: row.usedBytes,
          quota_bytes: row.quotaBytes,
        })),
        table: {
          rows: spaces,
          columns: [
            { header: "ID", value: (row) => row.id },
            { header: "Name", value: (row) => row.name ?? "(sealed)", max: 40 },
            { header: "Mode", value: (row) => row.mode },
            { header: "Used", value: (row) => `${row.usedBytes} / ${row.quotaBytes}` },
          ],
        },
      });
    });

  space
    .command("get")
    .description("Read one space")
    .argument("<id>")
    .action(async (id: string, _options, command: Command) => {
      const { memdot } = await connect(command);
      emit({ data: await memdot.spaces.get(id) });
    });

  space
    .command("create")
    .description("Create a space, which takes the owner's keys")
    .argument("<name>")
    .option("--self-signed", "your wallet signs each store")
    .action(async (name: string, options, command: Command) => {
      const { memdot } = await connect(command);
      const created = await memdot.spaces.create({
        name,
        mode: options.selfSigned ? "self_signed" : "sponsored",
      });
      emit({ data: created, text: () => console.log(`Created ${created.id}`) });
    });

  space
    .command("rename")
    .description("Rename a space")
    .argument("<id>")
    .argument("<name>")
    .action(async (id: string, name: string, _options, command: Command) => {
      const { memdot } = await connect(command);
      emit({ data: await memdot.spaces.rename(id, name), text: () => console.log("Renamed.") });
    });

  space
    .command("rm")
    .description("Delete a space and everything in it")
    .argument("<id>")
    .option("--force", "don't ask")
    .action(async (id: string, options, command: Command) => {
      const { memdot } = await connect(command);
      await confirmDestructive(`Delete space ${id} and everything in it?`, options.force);
      await memdot.spaces.delete(id);
      emit({ data: { id, deleted: true }, text: () => console.log("Deleted.") });
    });

  const folder = program.command("folder").description("Folders inside a space");

  folder
    .command("ls")
    .description("List folders in a space")
    .option("--space <id>")
    .action(async (options, command: Command) => {
      const { memdot } = await connect(command);
      const folders = await memdot.folders.list(await spaceOf(memdot, options.space));
      emit({
        count: folders.length,
        data: folders.map((row) => ({
          id: row.id,
          name: row.name,
          parent_id: row.parentId,
          memory_mode: row.memoryMode,
        })),
        table: {
          rows: folders,
          columns: [
            { header: "ID", value: (row) => row.id },
            { header: "Name", value: (row) => row.name ?? "(sealed)", max: 40 },
            { header: "Memory", value: (row) => row.memoryMode },
          ],
        },
      });
    });

  folder
    .command("create")
    .description("Create a folder; its name is sealed here")
    .argument("<name>")
    .option("--space <id>")
    .option("--parent <id>")
    .action(async (name: string, options, command: Command) => {
      const { memdot } = await connect(command);
      const created = await memdot.folders.create(await spaceOf(memdot, options.space), {
        name,
        ...(options.parent ? { parentId: options.parent } : {}),
      });
      emit({ data: created, text: () => console.log(`Created ${created.id}`) });
    });

  folder
    .command("rename")
    .description("Rename a folder")
    .argument("<id>")
    .argument("<name>")
    .option("--space <id>")
    .action(async (id: string, name: string, options, command: Command) => {
      const { memdot } = await connect(command);
      const renamed = await memdot.folders.rename(id, await spaceOf(memdot, options.space), name);
      emit({ data: renamed, text: () => console.log("Renamed.") });
    });

  folder
    .command("rm")
    .description("Delete a folder")
    .argument("<id>")
    .option("--force", "don't ask")
    .action(async (id: string, options, command: Command) => {
      const { memdot } = await connect(command);
      await confirmDestructive(`Delete folder ${id}?`, options.force);
      await memdot.folders.delete(id);
      emit({ data: { id, deleted: true }, text: () => console.log("Deleted.") });
    });

  const namespace = program.command("namespace").description("Where memories live");

  namespace
    .command("ls")
    .description("List namespaces")
    .option("--space <id>")
    .action(async (options, command: Command) => {
      const { memdot, resolved } = await connect(command);
      const namespaces = await memdot.memories.namespaces(options.space);
      emit({
        count: namespaces.length,
        data: {
          default_namespace_id: resolved.namespaceId,
          namespaces: namespaces.map((row) => ({
            id: row.id,
            name: row.name,
            mode: row.mode,
            space_id: row.spaceId,
            total_memories: row.totalMemories,
            last_write: row.lastWrite,
          })),
        },
        table: {
          rows: namespaces,
          columns: [
            { header: "ID", value: (row) => row.id },
            {
              header: "Name",
              value: (row) =>
                `${row.name ?? "(sealed)"}${row.id === resolved.namespaceId ? " *" : ""}`,
              max: 40,
            },
            { header: "Mode", value: (row) => row.mode },
            { header: "Memories", value: (row) => String(row.totalMemories) },
          ],
        },
      });
    });

  namespace
    .command("create")
    .description("Create a namespace; its mode can't change afterwards")
    .argument("<name>")
    .requiredOption(
      "--mode <mode>",
      "private: only devices with the key read it. assisted: the server reads text.",
    )
    .option("--space <id>")
    .action(async (name: string, options, command: Command) => {
      if (options.mode !== "private" && options.mode !== "assisted") {
        throw new CliError("--mode is private or assisted.", EXIT.usage, "BAD_MODE");
      }
      const { memdot } = await connect(command);
      const created = await memdot.memories.createNamespace({
        spaceId: await spaceOf(memdot, options.space),
        name,
        mode: options.mode,
      });
      emit({ data: created, text: () => console.log(`Created ${created.id}`) });
    });
}
