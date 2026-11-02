import { ageIdentity, ageRecipient, generateX25519, openWith } from "@memdot/crypto";
import type { Context, Schemas } from "./context.js";
import { MemDotError } from "./errors.js";
import type { SharingApi } from "./sharing.js";
import { fromBase64 } from "./spaces.js";
import { unwrap } from "./transport.js";

export type Agent = Schemas["Agent"];
export type ConnectRequest = Schemas["ConnectRequest"];

export interface ConnectStart {
  id: string;
  /** Shown in both places, so the owner can tell it's their own terminal asking. */
  code: string;
  /** Where the owner approves it. */
  url: string;
  pollSecret: string;
  pollIntervalSeconds: number;
  expiresAt: string;
}

export interface ConnectResult {
  status: "pending" | "approved" | "denied" | "delivered" | "expired";
  /** Opened on this device, only when status is approved. */
  apiKey: string | null;
  agentId: string | null;
  namespaceId: string | null;
}

export interface ApproveConnect {
  spaceIds: string[];
  role: "read_only" | "read_write";
  /** Where it remembers by default. */
  namespaceId?: string;
  expiresInDays?: number;
}

/** A fresh key pair for a device. The identity never leaves it. */
export function newAgentIdentity(): { identity: string; publicKey: string } {
  const { publicKey, secretKey } = generateX25519();
  return { identity: ageIdentity(secretKey), publicKey: ageRecipient(publicKey) };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Connected agents. A device asks with `startConnect` and collects with `pollConnect`; the owner,
 * unlocked in a browser, answers with `approveConnect`, which wraps each chosen space's keys to the
 * device's public key. A hosted agent holds no key, so it is allowed with `allowHosted` and reaches
 * Assisted namespaces only.
 */
export class AgentsApi {
  constructor(
    private readonly ctx: Context,
    private readonly sharing: SharingApi,
  ) {}

  async list(): Promise<Agent[]> {
    const { items } = await unwrap(this.ctx.transport.api.GET("/v1/agents"));
    return items;
  }

  rename(id: string, label: string): Promise<Agent> {
    return unwrap(
      this.ctx.transport.api.PATCH("/v1/agents/{id}", {
        params: { path: { id } },
        body: { label },
      }),
    );
  }

  /** Stops its keys and tokens at once, and moves the spaces it held to a new key epoch. */
  async revoke(agent: Pick<Agent, "id" | "publicKey">) {
    const revoked = await unwrap(
      this.ctx.transport.api.DELETE("/v1/agents/{id}", { params: { path: { id: agent.id } } }),
    );
    if (agent.publicKey) await this.ctx.registry.revokeAgent(agent.publicKey);
    return revoked;
  }

  // ── On the device ───────────────────────────────────────────────────────────────────────────

  startConnect(input: { publicKey: string; label: string; client: string }): Promise<ConnectStart> {
    return unwrap(this.ctx.transport.api.POST("/v1/connect", { body: input }));
  }

  async pollConnect(id: string, pollSecret: string, identity: string): Promise<ConnectResult> {
    const result = await unwrap(
      this.ctx.transport.api.POST("/v1/connect/{id}/poll", {
        params: { path: { id } },
        body: { pollSecret },
      }),
    );
    const apiKey = result.sealedKey
      ? new TextDecoder().decode(
          await openWith(fromBase64(result.sealedKey), identity, "the connection"),
        )
      : null;
    return {
      status: result.status,
      apiKey,
      agentId: result.agentId,
      namespaceId: result.namespaceId,
    };
  }

  // ── In the owner's browser ──────────────────────────────────────────────────────────────────

  connectRequest(id: string): Promise<ConnectRequest> {
    return unwrap(this.ctx.transport.api.GET("/v1/connect/{id}", { params: { path: { id } } }));
  }

  denyConnect(id: string) {
    return unwrap(
      this.ctx.transport.api.POST("/v1/connect/{id}/deny", { params: { path: { id } } }),
    );
  }

  /**
   * Registers the agent, wraps each space's keys to it, then lets the device collect its API key.
   * Safe to call again if it stops part way: what's already done is left alone.
   */
  async approveConnect(request: ConnectRequest, choice: ApproveConnect): Promise<Agent> {
    const agent = await this.registered(request);
    const expiresAt = choice.expiresInDays
      ? new Date(Date.now() + choice.expiresInDays * DAY_MS).toISOString()
      : undefined;
    const scope = choice.role === "read_write" ? "read_write" : "read";
    for (const spaceId of choice.spaceIds) {
      const { items } = await this.sharing.list("given", spaceId);
      const held = items.some(
        (grant) =>
          grant.grantee === agent.publicKey && grant.status === "active" && !grant.objectId,
      );
      if (held) continue;
      await this.sharing.shareSpace(
        spaceId,
        { agentId: agent.id, agentKey: request.publicKey },
        { scope, ...(expiresAt ? { expiresAt } : {}) },
      );
    }
    await unwrap(
      this.ctx.transport.api.POST("/v1/connect/{id}/approve", {
        params: { path: { id: request.id } },
        body: { agentId: agent.id, ...choice },
      }),
    );
    return agent;
  }

  /** What the OAuth consent page sends before it accepts: where this client may go. */
  allowHosted(input: Schemas["NewHostedAgent"]): Promise<Agent> {
    return unwrap(this.ctx.transport.api.POST("/v1/agents/hosted", { body: input }));
  }

  /** The client asking to connect, as it described itself. Nothing vouches for this name. */
  oauthClient(clientId: string): Promise<{ client_name?: string; client_uri?: string }> {
    return this.ctx.transport.json(
      "GET",
      `/api/auth/oauth2/public-client?client_id=${encodeURIComponent(clientId)}`,
    );
  }

  /** Answers an OAuth request; send the browser to the address this returns. */
  async answerOAuth(oauthQuery: string, accept: boolean): Promise<string> {
    const { url } = await this.ctx.transport.json<{ url: string }>(
      "POST",
      "/api/auth/oauth2/consent",
      { accept, oauth_query: oauthQuery },
    );
    return url;
  }

  private async registered(request: ConnectRequest): Promise<Agent> {
    try {
      const agent = await unwrap(
        this.ctx.transport.api.POST("/v1/agents", {
          body: { label: request.label, client: request.client, publicKey: request.publicKey },
        }),
      );
      await this.ctx.registry.registerAgent(request.publicKey);
      return agent;
    } catch (error) {
      if (!(error instanceof MemDotError) || error.code !== "AGENT_KEY_TAKEN") throw error;
      const agent = (await this.list()).find(
        (candidate) => candidate.publicKey === request.publicKey && !candidate.revokedAt,
      );
      if (!agent) throw error;
      return agent;
    }
  }
}
