import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { Context } from "./context.js";
import { MemDotError } from "./errors.js";
import type { FilesApi, ListedFile } from "./files.js";
import type { MemoriesApi, MemoryMode } from "./memories.js";
import type { FoldersApi, SpacesApi } from "./spaces.js";
import { unwrap } from "./transport.js";

const MANIFEST = "manifest.json";
const LIST_PAGE = 200;

/** What's in an export: everything but the file bytes, which sit beside it in the zip. */
export interface ExportManifest {
  format: "memdot-export";
  version: 1;
  exportedAt: string;
  spaces: {
    id: string;
    name: string;
    mode: string;
    folders: { id: string; name: string; parentId: string | null }[];
    files: { path: string; name: string; mime: string; size: number; folderId: string | null }[];
    namespaces: {
      id: string;
      name: string;
      mode: MemoryMode;
      memories: Record<string, unknown>[];
    }[];
  }[];
}

export interface ExportProgress {
  /** What's being read now, for showing progress. */
  step: string;
  done: number;
  total: number;
}

export interface ArchiveFile {
  path: string;
  data: Uint8Array;
}

export interface ImportReport {
  spaces: number;
  folders: number;
  files: number;
  memories: number;
  duplicates: number;
  /** What couldn't be brought in, and why. A full space stops its files, not the whole import. */
  failures: { item: string; reason: string }[];
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Zip entries can't climb out of the archive, and two files can share a name in different folders. */
const safeName = (name: string) => name.replace(/[/\\]/g, "_").replace(/^\.+/, "_") || "file";

/**
 * Taking your data with you. Everything is decrypted on this device: an export holds plaintext, so
 * it should be kept as carefully as the data itself.
 */
export class DataApi {
  constructor(
    private readonly ctx: Context,
    private readonly spaces: SpacesApi,
    private readonly folders: FoldersApi,
    private readonly files: FilesApi,
    private readonly memories: MemoriesApi,
  ) {}

  private async allFiles(spaceId: string): Promise<ListedFile[]> {
    const items: ListedFile[] = [];
    let cursor: string | null = null;
    do {
      const page: Awaited<ReturnType<FilesApi["list"]>> = await this.files.list({
        spaceId,
        limit: LIST_PAGE,
        ...(cursor ? { cursor } : {}),
      });
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    return items;
  }

  /** Reads every space, file and memory this device can open, into one zip. */
  async exportArchive(options: { onProgress?: (progress: ExportProgress) => void } = {}): Promise<{
    zip: Uint8Array;
    manifest: ExportManifest;
    /** Files that couldn't be read back. They are named, never silently left out. */
    failures: { item: string; reason: string }[];
  }> {
    const spaces = await this.spaces.list();
    const failures: { item: string; reason: string }[] = [];
    const archive: Record<string, Uint8Array> = {};
    const manifest: ExportManifest = {
      format: "memdot-export",
      version: 1,
      exportedAt: new Date().toISOString(),
      spaces: [],
    };

    const listed = await Promise.all(
      spaces.map(async (space) => ({
        space,
        folders: await this.folders.list(space.id),
        files: await this.allFiles(space.id),
        namespaces: await this.memories.namespaces(space.id),
      })),
    );
    const total = listed.reduce(
      (sum, { files, namespaces }) => sum + files.length + namespaces.length,
      0,
    );
    let done = 0;
    const report = (step: string) => options.onProgress?.({ step, done, total });

    for (const { space, folders, files, namespaces } of listed) {
      const entry: ExportManifest["spaces"][number] = {
        id: space.id,
        name: space.name ?? space.id,
        mode: space.mode,
        folders: folders
          .filter((folder) => folder.memoryMode === "off")
          .map((folder) => ({
            id: folder.id,
            name: folder.name ?? folder.id,
            parentId: folder.parentId,
          })),
        files: [],
        namespaces: [],
      };
      const used = new Set<string>();
      for (const file of files) {
        if (file.status !== "stored") continue;
        const label = file.name ?? file.id;
        report(label);
        try {
          const { data, name, mime } = await this.files.get(file.id);
          let path = `files/${safeName(entry.name)}/${safeName(name)}`;
          if (used.has(path)) path = `files/${safeName(entry.name)}/${file.id}-${safeName(name)}`;
          used.add(path);
          archive[path] = data;
          entry.files.push({ path, name, mime, size: data.length, folderId: file.folderId });
        } catch (error) {
          failures.push({ item: label, reason: reason(error) });
        }
        done += 1;
      }
      for (const namespace of namespaces) {
        const label = namespace.name ?? namespace.id;
        report(label);
        try {
          entry.namespaces.push({
            id: namespace.id,
            name: label,
            mode: namespace.mode,
            memories: await this.memories.exportMemories(namespace.id),
          });
        } catch (error) {
          failures.push({ item: label, reason: reason(error) });
        }
        done += 1;
      }
      manifest.spaces.push(entry);
    }

    archive[MANIFEST] = strToU8(JSON.stringify(manifest, null, 2));
    return { zip: zipSync(archive), manifest, failures };
  }

  /**
   * Brings an export back: into new spaces with the same names, or one you name. Sponsored spaces
   * hold little, so a big export may need a wallet-paid space; what doesn't fit is reported.
   */
  async importArchive(
    zip: Uint8Array,
    options: { spaceId?: string; onProgress?: (progress: ExportProgress) => void } = {},
  ): Promise<ImportReport> {
    const entries = unzipSync(zip);
    const rawManifest = entries[MANIFEST];
    if (!rawManifest)
      throw new MemDotError(400, "NOT_AN_EXPORT", "That zip isn't a MemDot export.");
    const manifest = JSON.parse(strFromU8(rawManifest)) as ExportManifest;
    if (manifest.format !== "memdot-export" || manifest.version !== 1) {
      throw new MemDotError(
        400,
        "NOT_AN_EXPORT",
        "That zip isn't a MemDot export this version can read.",
      );
    }

    const report: ImportReport = {
      spaces: 0,
      folders: 0,
      files: 0,
      memories: 0,
      duplicates: 0,
      failures: [],
    };
    const total = manifest.spaces.reduce(
      (sum, space) => sum + space.files.length + space.namespaces.length,
      0,
    );
    let done = 0;
    const step = (label: string) => options.onProgress?.({ step: label, done, total });

    for (const exported of manifest.spaces) {
      let spaceId = options.spaceId;
      if (!spaceId) {
        try {
          spaceId = (await this.spaces.create({ name: exported.name })).id;
          report.spaces += 1;
        } catch (error) {
          report.failures.push({ item: exported.name, reason: reason(error) });
          continue;
        }
      }
      const folderIds = new Map<string, string>();
      // Parents come before children, in as many passes as the tree is deep.
      let pending = [...exported.folders];
      while (pending.length > 0) {
        const ready = pending.filter(
          (folder) => !folder.parentId || folderIds.has(folder.parentId),
        );
        if (ready.length === 0) break;
        for (const folder of ready) {
          const parentId = folder.parentId ? folderIds.get(folder.parentId) : null;
          const created = await this.folders.create(spaceId, {
            name: folder.name,
            parentId: parentId ?? null,
          });
          folderIds.set(folder.id, created.id);
          report.folders += 1;
        }
        pending = pending.filter((folder) => !ready.includes(folder));
      }
      for (const file of exported.files) {
        step(file.name);
        const data = entries[file.path];
        if (!data) {
          report.failures.push({ item: file.name, reason: "Missing from the zip." });
        } else {
          try {
            const folderId = file.folderId ? folderIds.get(file.folderId) : undefined;
            await this.files.put(data, {
              spaceId,
              name: file.name,
              mime: file.mime,
              wait: false,
              ...(folderId ? { folderId } : {}),
            });
            report.files += 1;
          } catch (error) {
            report.failures.push({ item: file.name, reason: reason(error) });
          }
        }
        done += 1;
      }
      for (const namespace of exported.namespaces) {
        step(namespace.name);
        try {
          const created = await this.memories.createNamespace({
            spaceId,
            name: namespace.name,
            mode: namespace.mode,
          });
          if (namespace.memories.length > 0) {
            const result = await this.memories.importMemories(namespace.memories, {
              namespaceId: created.id,
              source: "memdot-export",
              userId: "imported",
            });
            report.memories += result.imported;
            report.duplicates += result.duplicates;
          }
        } catch (error) {
          report.failures.push({ item: namespace.name, reason: reason(error) });
        }
        done += 1;
      }
    }
    return report;
  }

  /**
   * Deletes this account: stops every renewal, forgets all memories, revokes keys, agents and
   * grants, and removes its sign-in methods. Stored bytes expire from the chain within 7 days.
   * Export first if you want a copy; nothing brings it back. Dashboard sessions only.
   */
  async deleteAccount(): Promise<void> {
    await this.ctx.registry.deleteAccount();
    await unwrap(this.ctx.transport.api.DELETE("/v1/account"));
    this.ctx.vault.lock();
  }
}
