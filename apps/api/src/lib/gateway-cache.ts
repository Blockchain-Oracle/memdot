import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Ciphertext the gateway fetched from the chain, kept on local disk and evicted least recently
 * used first. Content-addressed, so an entry never goes stale. Safe to lose: it refills from
 * `bitswap_v1_get`.
 */
export class CiphertextCache {
  /** Map order is recency order: the first key is the eviction candidate. */
  private readonly entries = new Map<string, number>();
  private total = 0;

  private constructor(
    private readonly dir: string,
    private readonly maxBytes: number,
  ) {}

  static async open(dir: string, maxBytes: number): Promise<CiphertextCache> {
    const cache = new CiphertextCache(dir, maxBytes);
    await mkdir(dir, { recursive: true });
    const files = await readdir(dir);
    const found = await Promise.all(
      files
        .filter((name) => !name.endsWith(".tmp"))
        .map(async (name) => ({ name, info: await stat(join(dir, name)) })),
    );
    for (const { name, info } of found.sort((a, b) => a.info.mtimeMs - b.info.mtimeMs)) {
      cache.entries.set(name, info.size);
      cache.total += info.size;
    }
    await cache.evict();
    return cache;
  }

  async get(cid: string): Promise<Uint8Array | null> {
    const size = this.entries.get(cid);
    if (size === undefined) return null;
    try {
      const bytes = await readFile(join(this.dir, cid));
      this.entries.delete(cid);
      this.entries.set(cid, size);
      return new Uint8Array(bytes);
    } catch {
      this.forget(cid);
      return null;
    }
  }

  async put(cid: string, bytes: Uint8Array): Promise<void> {
    if (this.entries.has(cid) || bytes.length > this.maxBytes) return;
    const path = join(this.dir, cid);
    await writeFile(`${path}.tmp`, bytes);
    await rename(`${path}.tmp`, path);
    this.entries.set(cid, bytes.length);
    this.total += bytes.length;
    await this.evict();
  }

  private forget(cid: string): void {
    const size = this.entries.get(cid);
    if (size === undefined) return;
    this.entries.delete(cid);
    this.total -= size;
  }

  private async evict(): Promise<void> {
    while (this.total > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) return;
      this.forget(oldest);
      await unlink(join(this.dir, oldest)).catch(() => {});
    }
  }
}
