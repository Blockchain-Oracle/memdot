// Prints the relayer's free tPOT balance and what it covers (registry deploy, stores, renewals).
import { createChainClient, formatTpot, signerFromMnemonic } from "../src/index.js";
import { loadRootEnv, requireEnv } from "./env.js";

loadRootEnv();
const signer = signerFromMnemonic(requireEnv("SIGNER_MNEMONIC"));
const chain = createChainClient(process.env.PORTALDOT_WSS);
try {
  const account = await chain.api.query.System.Account.getValue(signer.address);
  console.log(`relayer ${signer.address}`);
  console.log(`free      ${formatTpot(account.data.free)}`);
  console.log(`reserved  ${formatTpot(account.data.reserved)}`);
} finally {
  chain.destroy();
}
