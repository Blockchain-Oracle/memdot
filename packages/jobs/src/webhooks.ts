import { type Database, webhookDeliveries, webhooks } from "@memdot/db";
import { and, arrayContains, eq } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { QUEUE } from "./queues.js";

type Executor = Pick<Database, "select" | "insert">;

/** What an account can subscribe to. `webhook.test` is only ever sent on request. */
export const WEBHOOK_EVENTS = [
  "memory.added",
  "memory.updated",
  "memory.deleted",
  "file.stored",
  "file.deleted",
] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number] | "webhook.test";

/** Ids and nothing else (R10): a webhook says what happened, and never what a memory or file says. */
export interface WebhookData {
  namespace_id?: string;
  space_id?: string;
  memory_ids?: string[];
  object_id?: string;
}

/** Queues one delivery to one webhook. */
export async function queueDelivery(
  boss: PgBoss,
  db: Executor,
  webhookId: string,
  event: WebhookEvent,
  data: WebhookData,
): Promise<string> {
  const [row] = await db
    .insert(webhookDeliveries)
    .values({ webhookId, event, payload: data })
    .returning({ id: webhookDeliveries.id });
  const id = (row as { id: string }).id;
  await boss.send(QUEUE.webhooks, { deliveryId: id });
  return id;
}

/**
 * Tells whoever subscribed. Telling them is never worth failing what actually happened, so a problem
 * here is logged and goes no further.
 */
export async function emitWebhooks(
  boss: PgBoss,
  db: Executor,
  accountId: string,
  event: WebhookEvent,
  data: WebhookData,
): Promise<void> {
  try {
    const subscribed = await db
      .select({ id: webhooks.id })
      .from(webhooks)
      .where(
        and(
          eq(webhooks.accountId, accountId),
          eq(webhooks.active, true),
          arrayContains(webhooks.events, [event]),
        ),
      );
    for (const { id } of subscribed) await queueDelivery(boss, db, id, event, data);
  } catch (error) {
    console.warn("[webhooks] couldn't queue", event, (error as Error).message);
  }
}
