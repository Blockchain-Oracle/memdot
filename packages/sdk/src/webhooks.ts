import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import type { Context, Schemas } from "./context.js";
import { unwrap } from "./transport.js";

export type Webhook = Schemas["Webhook"];
export type WebhookDelivery = Schemas["WebhookDelivery"];

/** What can be subscribed to. A delivery holds ids and the event type, never what anything says. */
export const WEBHOOK_EVENTS = [
  "memory.added",
  "memory.updated",
  "memory.deleted",
  "file.stored",
  "file.deleted",
] as const;
export type WebhookEventName = (typeof WEBHOOK_EVENTS)[number];

/** How old a delivery may be before it's taken for a replay. */
const DEFAULT_TOLERANCE_SECONDS = 300;

const sameText = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let different = 0;
  for (let i = 0; i < a.length; i += 1) different |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return different === 0;
};

/**
 * Checks a delivery really came from MemDot, on your receiving end. Pass the raw body as it arrived,
 * since parsing and re-serializing it would change what was signed.
 *
 * ```ts
 * if (!verifyWebhook(await request.text(), request.headers.get("x-memdot-signature"), secret)) {
 *   return new Response("Bad signature", { status: 401 });
 * }
 * ```
 */
export function verifyWebhook(
  body: string,
  signature: string | null | undefined,
  secret: string,
  options: { toleranceSeconds?: number; now?: Date } = {},
): boolean {
  const parts = new Map(
    (signature ?? "").split(",").map((part) => part.split("=", 2) as [string, string]),
  );
  const timestamp = Number(parts.get("t"));
  const given = parts.get("v1");
  if (!Number.isFinite(timestamp) || !given) return false;
  const nowSeconds = (options.now ?? new Date()).getTime() / 1000;
  if (Math.abs(nowSeconds - timestamp) > (options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS)) {
    return false;
  }
  const expected = bytesToHex(
    hmac(sha256, utf8ToBytes(secret), utf8ToBytes(`${parts.get("t")}.${body}`)),
  );
  return sameText(expected, given);
}

/** Webhooks: tell another service when memories and files change. */
export class WebhooksApi {
  constructor(private readonly ctx: Context) {}

  async list(): Promise<Webhook[]> {
    return (await unwrap(this.ctx.transport.api.GET("/v1/webhooks"))).items;
  }

  /** The signing secret comes back once, here. MemDot keeps it sealed and can't show it again. */
  create(input: { name: string; url: string; events: WebhookEventName[] }) {
    return unwrap(this.ctx.transport.api.POST("/v1/webhooks", { body: input }));
  }

  update(
    id: string,
    change: { name?: string; url?: string; events?: WebhookEventName[]; active?: boolean },
  ) {
    return unwrap(
      this.ctx.transport.api.PATCH("/v1/webhooks/{id}", {
        params: { path: { id } },
        body: change,
      }),
    );
  }

  /** A new signing secret, returned once. The old one stops at once. */
  rotate(id: string) {
    return unwrap(
      this.ctx.transport.api.POST("/v1/webhooks/{id}/rotate", { params: { path: { id } } }),
    );
  }

  delete(id: string) {
    return unwrap(this.ctx.transport.api.DELETE("/v1/webhooks/{id}", { params: { path: { id } } }));
  }

  /** Sends a `webhook.test` event, to check the receiver. */
  test(id: string) {
    return unwrap(
      this.ctx.transport.api.POST("/v1/webhooks/{id}/test", { params: { path: { id } } }),
    );
  }

  async deliveries(id: string): Promise<WebhookDelivery[]> {
    const { items } = await unwrap(
      this.ctx.transport.api.GET("/v1/webhooks/{id}/deliveries", { params: { path: { id } } }),
    );
    return items;
  }

  resend(id: string, deliveryId: string) {
    return unwrap(
      this.ctx.transport.api.POST("/v1/webhooks/{id}/deliveries/{deliveryId}/resend", {
        params: { path: { id, deliveryId } },
      }),
    );
  }
}
