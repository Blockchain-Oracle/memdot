import type { ChainClient, LocalSigner } from "@memdot/chain";
import type { Database } from "@memdot/db";
import type { PgBoss } from "pg-boss";
import type { Env } from "./env.js";

/** Everything a handler needs; built once in main.ts. */
export interface Deps {
  db: Database;
  boss: PgBoss;
  chain: ChainClient;
  signer: LocalSigner;
  env: Env;
}

export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** The relayer's free balance, in planck. */
export async function freeBalance(deps: Deps): Promise<bigint> {
  const account = await deps.chain.api.query.System.Account.getValue(deps.signer.address);
  return account.data.free;
}

/** Next nonce including transactions still in the pool, so explicit nonces never collide. */
export function nextNonce(deps: Deps): Promise<number> {
  return deps.chain.client._request<number, [string]>("system_accountNextIndex", [
    deps.signer.address,
  ]);
}

export const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 1_000);
