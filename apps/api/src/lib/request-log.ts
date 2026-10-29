import { type Database, requestLogs } from "@memdot/db";

const FLUSH_INTERVAL_MS = 2_000;
const FLUSH_AT_ROWS = 200;
/** Cap on rows held while the database is unreachable; older rows are dropped first. */
const MAX_BUFFERED_ROWS = 10_000;
/** Rows per INSERT: 8 parameters each keeps a statement far below Postgres's 65,535 limit. */
const INSERT_CHUNK = 1_000;

type Row = typeof requestLogs.$inferInsert;

/**
 * The activity log (R10): method, path, status, latency, key prefix and client header. Never
 * bodies, never query strings. Rows are buffered and written in batches so logging costs one
 * insert per 2 seconds instead of one per request.
 */
export class RequestLog {
  private buffer: Row[] = [];
  private readonly timer: NodeJS.Timeout;
  private flushing: Promise<void> | null = null;

  constructor(private readonly db: Database) {
    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    this.timer.unref();
  }

  record(row: Row): void {
    this.buffer.push(row);
    if (this.buffer.length > MAX_BUFFERED_ROWS)
      this.buffer.splice(0, this.buffer.length - MAX_BUFFERED_ROWS);
    if (this.buffer.length >= FLUSH_AT_ROWS) void this.flush();
  }

  async flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    if (this.buffer.length === 0) return;
    const rows = this.buffer;
    this.buffer = [];
    this.flushing = this.write(rows).finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  private async write(rows: Row[]): Promise<void> {
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      const chunk = rows.slice(i, i + INSERT_CHUNK);
      try {
        await this.db.insert(requestLogs).values(chunk);
      } catch (error) {
        console.error("[request-log] write failed; keeping rows for the next flush", error);
        this.buffer = [...rows.slice(i), ...this.buffer].slice(-MAX_BUFFERED_ROWS);
        return;
      }
    }
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
  }
}
