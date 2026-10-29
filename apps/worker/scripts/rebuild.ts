// Re-reads a block range and rebuilds the relayer's storage records from the chain: every
// Stored/Renewed event it paid for, the current location of each blob, and the renewal history.
// Usage: pnpm --filter @memdot/worker chain:rebuild --from 238500 [--to 238900]

import { parseArgs } from "node:util";
import { createChainClient, signerFromMnemonic } from "@memdot/chain";
import { createDatabase } from "@memdot/db";
import { startBoss } from "@memdot/jobs";
import type { Deps } from "../src/deps.js";
import { env } from "../src/env.js";
import { indexBlock } from "../src/handlers/indexer.js";

const { values } = parseArgs({ options: { from: { type: "string" }, to: { type: "string" } } });
if (!values.from) throw new Error("pass --from <block>");

const database = createDatabase(env.DATABASE_URL, 2);
const boss = await startBoss(env.DATABASE_URL, "api");
const chain = createChainClient(env.PORTALDOT_WSS);
const deps: Deps = {
  db: database.db,
  boss,
  chain,
  signer: signerFromMnemonic(env.SIGNER_MNEMONIC),
  env,
};

try {
  const from = Number(values.from);
  const to = values.to ? Number(values.to) : (await chain.client.getFinalizedBlock()).number;
  let events = 0;
  for (let block = from; block <= to; block += 1) {
    events += await indexBlock(deps, block);
    if ((block - from) % 500 === 0) console.log(`block ${block} (${events} events so far)`);
  }
  console.log(`rebuilt ${from}–${to}: ${events} relayer storage events`);
} finally {
  await boss.stop({ graceful: false });
  chain.destroy();
  await database.close();
}
