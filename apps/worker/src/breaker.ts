import { formatTpot } from "@memdot/chain";
import { QUEUE } from "@memdot/jobs";
import { raiseAlert, resolveAlerts } from "./alerts.js";
import { type Deps, freeBalance } from "./deps.js";

/**
 * The low-balance breaker. Below LOW_BALANCE_TPOT the store worker stops taking jobs (they wait
 * in the queue, nothing is lost) so what is left pays for renewals, which keep running on their
 * own worker. When the relayer is topped up, stores resume by themselves.
 */
export class StoreBreaker {
  private workerId: string | null = null;

  constructor(
    private readonly deps: Deps,
    private readonly startStores: () => Promise<string>,
  ) {}

  get open(): boolean {
    return this.workerId === null;
  }

  async refresh(): Promise<void> {
    const balance = await freeBalance(this.deps);
    const low = balance < this.deps.env.lowBalancePlanck;
    if (low) {
      if (this.workerId) {
        await this.deps.boss.offWork(QUEUE.chainTx, { id: this.workerId, wait: false });
        this.workerId = null;
      }
      await raiseAlert(this.deps, {
        kind: "low_balance",
        message: `The relayer has ${formatTpot(balance)} free (threshold ${this.deps.env.LOW_BALANCE_TPOT} tPOT). New stores are paused; renewals continue. Top up ${this.deps.signer.address}.`,
        detail: { address: this.deps.signer.address, balance: balance.toString() },
      });
      return;
    }
    if (!this.workerId) {
      this.workerId = await this.startStores();
      await resolveAlerts(this.deps, "low_balance");
    }
  }
}
