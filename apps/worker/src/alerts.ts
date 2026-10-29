import { opsAlerts } from "@memdot/db";
import { QUEUE } from "@memdot/jobs";
import { and, eq, isNull } from "drizzle-orm";
import type { Deps } from "./deps.js";
import type { Env } from "./env.js";

export type AlertKind = "low_balance" | "renewal_at_risk" | "item_lost" | "store_failed";

export interface AlertMessage {
  kind: AlertKind;
  message: string;
  detail?: Record<string, unknown>;
}

/**
 * Records an ops alert and queues its Discord delivery. While an alert of the same kind is open
 * it is not raised again, so a stuck condition pages once, not every scan.
 */
export async function raiseAlert(deps: Deps, alert: AlertMessage): Promise<void> {
  const [open] = await deps.db
    .select({ id: opsAlerts.id })
    .from(opsAlerts)
    .where(and(eq(opsAlerts.kind, alert.kind), isNull(opsAlerts.resolvedAt)))
    .limit(1);
  if (open) return;
  await deps.db
    .insert(opsAlerts)
    .values({ kind: alert.kind, message: alert.message, detail: alert.detail ?? null });
  await deps.boss.send(QUEUE.alerts, alert);
  console.warn(`[alert] ${alert.kind}: ${alert.message}`);
}

export async function resolveAlerts(deps: Deps, kind: AlertKind): Promise<void> {
  const resolved = await deps.db
    .update(opsAlerts)
    .set({ resolvedAt: new Date() })
    .where(and(eq(opsAlerts.kind, kind), isNull(opsAlerts.resolvedAt)))
    .returning({ id: opsAlerts.id });
  if (resolved.length > 0) {
    await deps.boss.send(QUEUE.alerts, { kind, message: `Resolved: ${kind.replace(/_/g, " ")}` });
  }
}

/** The `alerts` queue handler: posts to the ops Discord channel when a webhook is configured. */
export async function deliverAlert(env: Env, alert: AlertMessage): Promise<void> {
  if (!env.DISCORD_ALERT_WEBHOOK_URL) return;
  const response = await fetch(env.DISCORD_ALERT_WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "MemDot ops",
      content: `**${alert.kind.replace(/_/g, " ")}**: ${alert.message}`,
      allowed_mentions: { parse: [] },
    }),
  });
  if (!response.ok) throw new Error(`Discord webhook answered ${response.status}`);
}
