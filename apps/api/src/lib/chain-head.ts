import type { ChainClient } from "@memdot/chain";

/**
 * The latest finalized block, kept current from PAPI's subscription so retention countdowns
 * never wait on an RPC round trip.
 */
export class ChainHead {
  private latest: number | null = null;
  private readonly subscription: { unsubscribe: () => void };

  constructor(chain: ChainClient) {
    this.subscription = chain.client.finalizedBlock$.subscribe({
      next: (block) => {
        this.latest = block.number;
      },
      error: (error) => console.error("[chain-head] subscription failed", error),
    });
  }

  get block(): number | null {
    return this.latest;
  }

  close(): void {
    this.subscription.unsubscribe();
  }
}
