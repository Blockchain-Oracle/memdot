import type { Context, Schemas } from "./context.js";
import { unwrap } from "./transport.js";

export type ApiKey = Schemas["ApiKey"];
export type NewApiKey = Schemas["NewApiKey"];

/**
 * API keys for servers, scripts and agents. The full key is returned once, at creation or
 * rotation; MemDot keeps only a hash. Managing keys needs a dashboard session or an account-wide
 * management key, and a recent sign-in.
 */
export class KeysApi {
  constructor(private readonly ctx: Context) {}

  list() {
    return unwrap(this.ctx.transport.api.GET("/v1/keys"));
  }

  /** `role` defaults to read_write; `spaceIds` limits the key to some spaces (default: all). */
  create(input: {
    name: string;
    role?: ApiKey["role"];
    spaceIds?: string[] | null;
    agentId?: string;
    expiresInDays?: number;
  }): Promise<NewApiKey> {
    return unwrap(
      this.ctx.transport.api.POST("/v1/keys", {
        body: { ...input, role: input.role ?? "read_write", spaceIds: input.spaceIds ?? null },
      }),
    );
  }

  /** Revokes the key first, then mints a new one with the same name, role and spaces. */
  rotate(id: string): Promise<NewApiKey> {
    return unwrap(
      this.ctx.transport.api.POST("/v1/keys/{id}/rotate", { params: { path: { id } } }),
    );
  }

  revoke(id: string) {
    return unwrap(this.ctx.transport.api.DELETE("/v1/keys/{id}", { params: { path: { id } } }));
  }
}
