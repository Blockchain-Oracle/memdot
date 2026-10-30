import type { Context, Schemas } from "./context.js";
import { unwrap } from "./transport.js";

export type CidProof = Schemas["CidProof"];
export type TxProof = Schemas["TxProof"];
export type ProofStats = Schemas["ProofStats"];
export type ProofRecent = Schemas["ProofRecent"];

/**
 * Public proof: where a CID lives on Portaldot and its renewal history, what a transaction
 * stored, and network-wide totals. No account needed; the bytes stay encrypted.
 */
export class ProofApi {
  constructor(private readonly ctx: Context) {}

  cid(cid: string): Promise<CidProof> {
    return unwrap(this.ctx.transport.api.GET("/v1/proof/cid/{cid}", { params: { path: { cid } } }));
  }

  tx(hash: string): Promise<TxProof> {
    return unwrap(
      this.ctx.transport.api.GET("/v1/proof/tx/{hash}", { params: { path: { hash } } }),
    );
  }

  stats(): Promise<ProofStats> {
    return unwrap(this.ctx.transport.api.GET("/v1/proof/stats"));
  }

  recent(): Promise<ProofRecent> {
    return unwrap(this.ctx.transport.api.GET("/v1/proof/recent"));
  }
}
