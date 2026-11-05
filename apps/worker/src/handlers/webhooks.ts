import { createHmac } from "node:crypto";
import { webhookDeliveries, webhooks } from "@memdot/db";
import { safeFetch } from "@memdot/memory-server";
import { eq } from "drizzle-orm";
import type { JobWithMetadata } from "pg-boss";
import { type Deps, errorText } from "../deps.js";

/** A slow receiver holds a worker slot, and it should answer before doing its real work. */
const DELIVERY_TIMEOUT_MS = 10_000;
const ERROR_CHARS = 200;

class EndpointRefused extends Error {
  constructor(status: number) {
    super(`The endpoint answered ${status}.`);
  }
}

/**
 * Sends one event, signed: `t=<unix seconds>,v1=<HMAC-SHA256 of "<t>.<body>">`. Signing the time as
 * well means a captured delivery can't be replayed later. Failing throws, and the queue tries again
 * with growing gaps.
 */
export async function deliverWebhook(
  deps: Deps,
  job: JobWithMetadata<{ deliveryId: string }>,
): Promise<void> {
  const [row] = await deps.db
    .select({ delivery: webhookDeliveries, webhook: webhooks })
    .from(webhookDeliveries)
    .innerJoin(webhooks, eq(webhookDeliveries.webhookId, webhooks.id))
    .where(eq(webhookDeliveries.id, job.data.deliveryId));
  if (!row) return;
  const { delivery, webhook } = row;

  const body = JSON.stringify({
    id: delivery.id,
    event: delivery.event,
    created_at: delivery.createdAt.toISOString(),
    data: delivery.payload,
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const secret = deps.memoryKeys.openForAccount(webhook.accountId, webhook.secretSealed);
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");

  const started = Date.now();
  const lastTry = job.retryCount >= job.retryLimit;
  try {
    const response = await safeFetch(webhook.url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      headers: {
        "content-type": "application/json",
        "user-agent": "MemDot-Webhooks/1",
        "x-memdot-event": delivery.event,
        "x-memdot-delivery": delivery.id,
        "x-memdot-signature": `t=${timestamp},v1=${signature}`,
      },
      body,
    });
    const delivered = response.status >= 200 && response.status < 300;
    await deps.db
      .update(webhookDeliveries)
      .set({
        attempts: delivery.attempts + 1,
        responseStatus: response.status,
        latencyMs: Date.now() - started,
        error: delivered ? null : `The endpoint answered ${response.status}.`,
        status: delivered ? "delivered" : lastTry ? "failed" : "pending",
        ...(delivered ? { deliveredAt: new Date() } : {}),
      })
      .where(eq(webhookDeliveries.id, delivery.id));
    // Written down above, in words a person can read. This only tells the queue to try again.
    if (!delivered) throw new EndpointRefused(response.status);
  } catch (error) {
    if (error instanceof EndpointRefused) throw error;
    const message = errorText(error).slice(0, ERROR_CHARS);
    await deps.db
      .update(webhookDeliveries)
      .set({
        attempts: delivery.attempts + 1,
        latencyMs: Date.now() - started,
        error: message,
        status: lastTry ? "failed" : "pending",
      })
      .where(eq(webhookDeliveries.id, delivery.id));
    throw error;
  }
}
