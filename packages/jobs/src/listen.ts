import pg from "pg";
import { JOB_EVENTS_CHANNEL, type JobEvent } from "./record.js";

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

type Listener = (event: JobEvent | "resync") => void;

/**
 * Holds one dedicated LISTEN connection and fans job events out to subscribers (SSE streams).
 * After a reconnect every subscriber gets "resync", because events sent while the connection
 * was down are lost; subscribers then re-read the job row.
 */
export class JobEventHub {
  private readonly byJob = new Map<string, Set<Listener>>();
  private readonly byAccount = new Map<string, Set<Listener>>();
  private client: pg.Client | null = null;
  private closed = false;
  private attempt = 0;

  private constructor(private readonly connectionString: string) {}

  static async start(connectionString: string): Promise<JobEventHub> {
    const hub = new JobEventHub(connectionString);
    await hub.connect();
    return hub;
  }

  /** Events for one job. Returns the unsubscribe function. */
  subscribeJob(jobId: string, listener: Listener): () => void {
    return add(this.byJob, jobId, listener);
  }

  /** Events for every job of one account (the dashboard's job tray). */
  subscribeAccount(accountId: string, listener: Listener): () => void {
    return add(this.byAccount, accountId, listener);
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.client?.end().catch(() => {});
  }

  private async connect(): Promise<void> {
    const client = new pg.Client({
      connectionString: this.connectionString,
      application_name: "memdot-job-events",
    });
    client.on("notification", (message) => {
      if (message.channel !== JOB_EVENTS_CHANNEL || !message.payload) return;
      this.dispatch(JSON.parse(message.payload) as JobEvent);
    });
    client.on("error", () => this.reconnect(client));
    client.on("end", () => this.reconnect(client));
    await client.connect();
    await client.query(`LISTEN ${JOB_EVENTS_CHANNEL}`);
    this.client = client;
    this.attempt = 0;
  }

  private reconnect(failed: pg.Client): void {
    if (this.closed || this.client !== failed) return;
    this.client = null;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.attempt, RECONNECT_MAX_MS);
    this.attempt += 1;
    setTimeout(() => {
      this.connect()
        .then(() => this.broadcast("resync"))
        .catch((error) => {
          console.error("[job-events] reconnect failed", error);
          this.client = failed;
          this.reconnect(failed);
        });
    }, delay).unref();
  }

  private dispatch(event: JobEvent): void {
    for (const listener of this.byJob.get(event.id) ?? []) listener(event);
    if (!event.accountId) return;
    for (const listener of this.byAccount.get(event.accountId) ?? []) listener(event);
  }

  private broadcast(event: "resync"): void {
    for (const set of [...this.byJob.values(), ...this.byAccount.values()]) {
      for (const listener of set) listener(event);
    }
  }
}

function add(map: Map<string, Set<Listener>>, key: string, listener: Listener): () => void {
  let set = map.get(key);
  if (!set) {
    set = new Set();
    map.set(key, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) map.delete(key);
  };
}
