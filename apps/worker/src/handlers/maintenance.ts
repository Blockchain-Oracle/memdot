import { connectRequests, memories, oauthClient, oauthConsent, objects } from "@memdot/db";
import { failObject } from "@memdot/jobs";
import { compactIfDue } from "@memdot/memory-server";
import { and, eq, isNull, lt, notExists, sql } from "drizzle-orm";
import type { Deps } from "../deps.js";

/** The activity log keeps 30 days of request metadata (R10); older rows are deleted daily. */
const REQUEST_LOG_DAYS = 30;
/** Deleted in batches so no single statement or transaction runs long. */
const PRUNE_BATCH = 10_000;
/** A declared upload whose blobs never all arrived is abandoned after a day. */
const ABANDONED_UPLOAD_HOURS = 24;
const MAX_ABANDONED_PER_RUN = 500;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const UNUSED_OAUTH_CLIENT_DAYS = 7;

export async function maintenance(deps: Deps): Promise<void> {
  const pruned = await pruneRequestLog(deps);
  const abandoned = await expireAbandonedUploads(deps);
  const compacted = await compactNamespaces(deps);
  const connects = await pruneConnectRequests(deps);
  const clients = await pruneOAuthClients(deps);
  console.log(
    `[maintenance] pruned ${pruned} request log rows, expired ${abandoned} abandoned uploads, checked ${compacted} namespaces, removed ${connects} old connect requests and ${clients} unused OAuth clients`,
  );
}

/** Anyone can register an OAuth client, so one nobody ever agreed to doesn't stay. */
async function pruneOAuthClients(deps: Deps): Promise<number> {
  const cutoff = new Date(Date.now() - UNUSED_OAUTH_CLIENT_DAYS * DAY_MS);
  const gone = await deps.db
    .delete(oauthClient)
    .where(
      and(
        lt(oauthClient.createdAt, cutoff),
        notExists(
          deps.db
            .select({ id: oauthConsent.id })
            .from(oauthConsent)
            .where(eq(oauthConsent.clientId, oauthClient.clientId)),
        ),
      ),
    )
    .returning({ id: oauthClient.id });
  return gone.length;
}

/** A `memdot login` nobody answered: it can't be approved or collected any more. */
async function pruneConnectRequests(deps: Deps): Promise<number> {
  const gone = await deps.db
    .delete(connectRequests)
    .where(lt(connectRequests.expiresAt, new Date()))
    .returning({ id: connectRequests.id });
  return gone.length;
}

/** Assisted namespaces with a segment that failed or is mostly forgotten get rewritten. */
async function compactNamespaces(deps: Deps): Promise<number> {
  const namespaces = await deps.db
    .selectDistinct({ folderId: memories.folderId, accountId: memories.accountId })
    .from(memories)
    .where(and(eq(memories.mode, "assisted"), isNull(memories.deletedAt)));
  for (const namespace of namespaces) await compactIfDue(deps.db, deps.boss, namespace);
  return namespaces.length;
}

async function pruneRequestLog(deps: Deps): Promise<number> {
  const cutoff = new Date(Date.now() - REQUEST_LOG_DAYS * 24 * HOUR_MS);
  let total = 0;
  for (;;) {
    const result = await deps.db.execute(sql`
      delete from request_logs where id in (
        select id from request_logs where created_at < ${cutoff} limit ${PRUNE_BATCH}
      )`);
    total += result.rowCount ?? 0;
    if ((result.rowCount ?? 0) < PRUNE_BATCH) return total;
  }
}

/**
 * Objects still waiting for their blobs a day after they were declared: the client is gone. They
 * fail like any other upload: quota returned, staged ciphertext dropped, the job closed.
 */
async function expireAbandonedUploads(deps: Deps): Promise<number> {
  const cutoff = new Date(Date.now() - ABANDONED_UPLOAD_HOURS * HOUR_MS);
  const stale = await deps.db
    .select({ id: objects.id })
    .from(objects)
    .where(and(eq(objects.status, "queued"), lt(objects.createdAt, cutoff)))
    .limit(MAX_ABANDONED_PER_RUN);
  let expired = 0;
  for (const object of stale) {
    const failed = await deps.db.transaction((tx) =>
      failObject(tx, object.id, "The upload was never completed; its reserved quota was released."),
    );
    if (failed) expired += 1;
  }
  return expired;
}
