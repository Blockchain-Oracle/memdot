import {
  EVM_CHAIN_ID,
  PORTALDOT_EVM_RPC,
  REGISTRY_ADDRESS,
  REGISTRY_DEPLOY_BLOCK,
} from "@memdot/config";
import { actionName, decodeRecord, memDotRegistryAbi } from "@memdot/contracts";
import { createPublicClient, defineChain, http } from "viem";

const client = createPublicClient({
  chain: defineChain({
    id: EVM_CHAIN_ID,
    name: "Portaldot V3",
    nativeCurrency: { name: "tPOT", symbol: "tPOT", decimals: 18 },
    rpcUrls: { default: { http: [PORTALDOT_EVM_RPC] } },
  }),
  transport: http(PORTALDOT_EVM_RPC),
});

export interface RegistryRecord {
  name: ReturnType<typeof actionName>;
  owner: string;
  spaceId: string;
  block: number;
  fields: Record<string, unknown> | null;
}

/**
 * The registry's records, newest first, read from Portaldot's EVM RPC by this browser. As every
 * reader must, it applies an (owner, nonce) pair once, so a replayed record changes nothing.
 */
export async function readRegistryRecords(): Promise<RegistryRecord[]> {
  const logs = await client.getContractEvents({
    address: REGISTRY_ADDRESS,
    abi: memDotRegistryAbi,
    eventName: "Recorded",
    fromBlock: BigInt(REGISTRY_DEPLOY_BLOCK),
    toBlock: "latest",
  });
  const seen = new Set<string>();
  const records: RegistryRecord[] = [];
  for (const { args, blockNumber } of logs) {
    const { owner, spaceId, action, nonce, data } = args;
    if (!owner || !spaceId || action === undefined || nonce === undefined || !data) continue;
    const key = `${owner}:${nonce}`;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push({
      name: actionName(action),
      owner,
      spaceId,
      block: Number(blockNumber),
      fields: decodeRecord(action, data),
    });
  }
  return records.reverse();
}
