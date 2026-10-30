import type { ChainClient } from "@memdot/chain";
import type { components } from "./schema.js";
import type { Transport } from "./transport.js";
import type { Vault } from "./vault.js";

export type Schemas = components["schemas"];

/** What every part of the SDK shares: the API connection, the unlocked keys, a chain link. */
export interface Context {
  transport: Transport;
  vault: Vault;
  /** A direct connection to Portaldot V3, opened on first use (verify, self-signed writes). */
  chain(): Promise<ChainClient>;
}
