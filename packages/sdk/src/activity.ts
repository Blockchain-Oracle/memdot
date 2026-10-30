import type { Context, Schemas } from "./context.js";
import { unwrap } from "./transport.js";

export type RequestLogEntry = Schemas["RequestLogEntry"];
export type ChainTransaction = Schemas["ChainTransaction"];

/** What happened on your account: API requests (metadata only) and every chain transaction. */
export class ActivityApi {
  constructor(private readonly ctx: Context) {}

  /** Method, path, status, latency, key prefix and client; never bodies. Newest first. */
  requests(query: { cursor?: string; limit?: number } = {}) {
    return unwrap(this.ctx.transport.api.GET("/v1/activity/requests", { params: { query } }));
  }

  /** Every store and renewal on Portaldot V3 for your data, newest first. */
  transactions(query: { cursor?: string; limit?: number } = {}) {
    return unwrap(this.ctx.transport.api.GET("/v1/activity/transactions", { params: { query } }));
  }
}
