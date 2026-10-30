import type { Context, Schemas } from "./context.js";
import { MemDotError } from "./errors.js";
import { unwrap } from "./transport.js";

export type Job = Schemas["Job"];

const TERMINAL = new Set(["finalized", "failed"]);
const POLL_MS = 2_000;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

export interface WaitOptions {
  /** Called on every change (queued → submitted → in block → finalized). */
  onUpdate?: (job: Job) => void;
  timeoutMs?: number;
  /** Reject when the job fails (default), or resolve with the failed job. */
  throwOnFailure?: boolean;
  signal?: AbortSignal;
}

export class JobFailedError extends MemDotError {
  constructor(readonly job: Job) {
    super(422, "JOB_FAILED", job.error ?? "The job failed.");
    this.name = "JobFailedError";
  }
}

export class JobsApi {
  constructor(private readonly ctx: Context) {}

  get(id: string): Promise<Job> {
    return unwrap(this.ctx.transport.api.GET("/v1/jobs/{id}", { params: { path: { id } } }));
  }

  list(query: { status?: Job["status"]; kind?: string; cursor?: string; limit?: number } = {}) {
    return unwrap(this.ctx.transport.api.GET("/v1/jobs", { params: { query } }));
  }

  /**
   * Follows a job to its end over Server-Sent Events, falling back to polling if the stream
   * drops. Each blob of an object reports progress (`job.progress`).
   */
  async waitFor(id: string, options: WaitOptions = {}): Promise<Job> {
    const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    // Report changes only: several writes can land on the same status and progress.
    let last = "";
    const report = options.onUpdate;
    options = {
      ...options,
      onUpdate: (job) => {
        const key = `${job.status}:${job.progress?.done ?? ""}/${job.progress?.total ?? ""}`;
        if (key === last) return;
        last = key;
        report?.(job);
      },
    };
    const done = (job: Job) => {
      options.onUpdate?.(job);
      if (job.status === "failed" && options.throwOnFailure !== false)
        throw new JobFailedError(job);
      return job;
    };

    try {
      const streamed = await this.stream(id, deadline, options);
      if (streamed) return done(streamed);
    } catch (error) {
      if (error instanceof JobFailedError) throw error;
      // The stream is a convenience; polling below is the source of truth.
    }

    for (;;) {
      const job = await this.get(id);
      if (TERMINAL.has(job.status)) return done(job);
      options.onUpdate?.(job);
      if (Date.now() > deadline) {
        throw new MemDotError(408, "JOB_TIMEOUT", `Job ${id} is still ${job.status}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }

  private async stream(id: string, deadline: number, options: WaitOptions): Promise<Job | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
    options.signal?.addEventListener("abort", () => controller.abort());
    try {
      const response = await this.ctx.transport.send("GET", `/v1/jobs/${id}/events`, {
        headers: { accept: "text/event-stream" },
      });
      const reader = response.body?.getReader();
      if (!reader) return null;
      controller.signal.addEventListener("abort", () => void reader.cancel());
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return null;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const job = JSON.parse(line.slice("data: ".length)) as Job;
          if (TERMINAL.has(job.status)) return job;
          options.onUpdate?.(job);
        }
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
