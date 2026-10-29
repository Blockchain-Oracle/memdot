import { PORTALDOT_WSS } from "@memdot/config";
import { portaldot } from "@polkadot-api/descriptors";
import { createClient, type PolkadotClient, type TypedApi } from "polkadot-api";
import { getWsProvider } from "polkadot-api/ws";

export type PortaldotApi = TypedApi<typeof portaldot>;

export interface ChainClient {
  client: PolkadotClient;
  api: PortaldotApi;
  destroy: () => void;
}

/** One client per process: PAPI multiplexes every call over a single connection. */
export function createChainClient(endpoint: string = PORTALDOT_WSS): ChainClient {
  const client = createClient(getWsProvider(endpoint));
  return {
    client,
    api: client.getTypedApi(portaldot),
    destroy: () => client.destroy(),
  };
}
