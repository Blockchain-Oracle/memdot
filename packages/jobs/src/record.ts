import { type Database, type jobStatus, jobs } from "@memdot/db";
import { eq, sql } from "drizzle-orm";

/**
 * Postgres channel carrying job status changes. The worker notifies inside its transaction, so
 * listeners (the API's SSE stream) only ever see committed states.
 */
export const JOB_EVENTS_CHANNEL = "memdot_job_events";

export type JobStatus = (typeof jobStatus.enumValues)[number];

export interface JobProgress {
  done: number;
  total: number;
}

/** What one SSE message tells a client about its job. Kept small: NOTIFY payloads cap at 8 KB. */
export interface JobEvent {
  id: string;
  accountId: string | null;
  kind: string;
  status: JobStatus;
  txHash: string | null;
  block: number | null;
  error: string | null;
  progress: JobProgress | null;
  updatedAt: string;
}

export interface JobPatch {
  status?: JobStatus;
  txHash?: string | null;
  block?: number | null;
  error?: string | null;
  progress?: JobProgress;
  result?: Record<string, unknown>;
}

type Executor = Pick<Database, "update" | "execute">;

function progressOf(result: unknown): JobProgress | null {
  const progress = (result as { progress?: JobProgress } | null)?.progress;
  return progress && typeof progress.done === "number" ? progress : null;
}

/** Updates a job row and announces the new state on JOB_EVENTS_CHANNEL. */
export async function updateJob(
  db: Executor,
  id: string,
  patch: JobPatch,
): Promise<JobEvent | null> {
  const { progress, result, ...columns } = patch;
  const merged =
    progress || result
      ? sql`coalesce(${jobs.result}, '{}'::jsonb) || ${JSON.stringify({ ...result, ...(progress ? { progress } : {}) })}::jsonb`
      : undefined;
  const [row] = await db
    .update(jobs)
    .set({ ...columns, ...(merged ? { result: merged } : {}), updatedAt: new Date() })
    .where(eq(jobs.id, id))
    .returning();
  if (!row) return null;

  const event = jobEventOf(row);
  await db.execute(sql`select pg_notify(${JOB_EVENTS_CHANNEL}, ${JSON.stringify(event)})`);
  return event;
}

export function jobEventOf(row: typeof jobs.$inferSelect): JobEvent {
  return {
    id: row.id,
    accountId: row.accountId,
    kind: row.kind,
    status: row.status,
    txHash: row.txHash,
    block: row.block,
    error: row.error,
    progress: progressOf(row.result),
    updatedAt: row.updatedAt.toISOString(),
  };
}
