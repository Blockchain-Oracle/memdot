import { EVM_CHAIN_ID } from "@memdot/config";
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import type { Env } from "./env.js";

/**
 * Portaldot's EVM RPC, and the relayer's EVM account from the same mnemonic. Registry records go
 * through it because the RPC only indexes logs of real EVM transactions, not of native
 * `Revive.call`s, and anyone reading the registry needs `eth_getLogs` to see them.
 */
export function createEvmClients(env: Env) {
  const chain = defineChain({
    id: EVM_CHAIN_ID,
    name: "Portaldot V3",
    nativeCurrency: { name: "tPOT", symbol: "tPOT", decimals: 18 },
    rpcUrls: { default: { http: [env.PORTALDOT_EVM_RPC] } },
  });
  const transport = http(env.PORTALDOT_EVM_RPC);
  const account = mnemonicToAccount(env.SIGNER_MNEMONIC);
  return {
    account,
    publicClient: createPublicClient({ chain, transport }),
    walletClient: createWalletClient({ chain, transport, account }),
  };
}

export type EvmClients = ReturnType<typeof createEvmClients>;
