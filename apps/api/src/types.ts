import type { ChainClient } from "@memdot/chain";
import type { JobEventHub } from "@memdot/jobs";
import type { PgBoss } from "pg-boss";
import type { ApiKeyRole, Permissions } from "./auth/roles.js";
import type { ChainHead } from "./lib/chain-head.js";
import type { CiphertextCache } from "./lib/gateway-cache.js";
import type { RequestLog } from "./lib/request-log.js";

/** Who is calling: a dashboard session or an API key, resolved once per request. */
export interface Principal {
  userId: string;
  via: "session" | "api_key";
  /** The MemDot account, once the client has finished setup (`PUT /v1/account`). */
  accountId: string | null;
  /** When the dashboard session signed in; sensitive changes need a recent one. */
  sessionCreatedAt: Date | null;
  apiKey: {
    id: string;
    /** First characters of the key (prefix included), safe to log and show. */
    start: string | null;
    role: ApiKeyRole;
    permissions: Permissions;
    /** Spaces the key may touch; null means all of the owner's spaces. */
    spaceIds: string[] | null;
    agentId: string | null;
  } | null;
}

/** Long-lived services the routes share; built once in main.ts. */
export interface Services {
  boss: PgBoss;
  chain: ChainClient;
  chainHead: ChainHead;
  gatewayCache: CiphertextCache;
  jobEvents: JobEventHub;
  requestLog: RequestLog;
}

export interface AppEnv {
  Variables: {
    requestId: string;
    principal: Principal | null;
  };
}
