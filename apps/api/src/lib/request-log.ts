import { type Database, requestLogs } from "@memdot/db";

const FLUSH_INTERVAL_MS = 2_000;
const FLUSH_AT_ROWS = 200;
/** Cap on rows held while the database is unreachable; older rows are dropped first. */
const MAX_BUFFERED_ROWS = 10_000;

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
    this.flushing = this.db
      .insert(requestLogs)
      .values(rows)
      .then(() => undefined)
      .catch((error) => {
        console.error("[request-log] write failed; keeping rows for the next flush", error);
        this.buffer = [...rows, ...this.buffer].slice(-MAX_BUFFERED_ROWS);
      })
      .finally(() => {
        this.flushing = null;
      });
    return this.flushing;
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    await this.flush();
  }
}
