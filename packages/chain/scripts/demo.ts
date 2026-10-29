// S01 check: read path always; write path (store 2 chunks → read back → renew) with --write.
// Usage: pnpm --filter @memdot/chain demo [--write]
import { randomBytes } from "node:crypto";
import { bitswapGet } from "../src/bitswap.js";
import { cidFromContentHash, cidOf, toBytes, toHex } from "../src/cid.js";
import { createChainClient } from "../src/client.js";
import { estimateStoreFee, formatTpot, quoteRenewFee, quoteStoreFee } from "../src/fees.js";
import { retentionState } from "../src/retention.js";
import { signerFromMnemonic } from "../src/signer.js";
import { renew, storeChunk } from "../src/storage.js";
import { loadRootEnv, requireEnv, writeEvidence } from "./env.js";

const DEMO_CHUNK_BYTES = 1_024;
const DEMO_CHUNKS = 2;

loadRootEnv();
const write = process.argv.includes("--write");
const signer = signerFromMnemonic(requireEnv("SIGNER_MNEMONIC"));
const { client, api, destroy } = createChainClient();

try {
  const head = await client.getFinalizedBlock();
  const retention = await api.apis.TransactionStorageApi.retention_period();
  const account = await api.query.System.Account.getValue(signer.address);
  console.log(`Head #${head.number} · retention ${retention} blocks`);
  console.log(`Signer ${signer.address} · free ${formatTpot(account.data.free)}`);

  // Read path: newest item anyone stored, fetched by CID and verified against its hash.
  const entries = await api.query.TransactionStorage.Transactions.getEntries();
  const newest = entries.sort((a, b) => b.keyArgs[0] - a.keyArgs[0])[0];
  if (newest?.value[0]) {
    const block = newest.keyArgs[0];
    const cid = cidFromContentHash(toBytes(newest.value[0].content_hash));
    const bytes = await bitswapGet(client, cid);
    const state = retentionState(block, head.number);
    console.log(`Read ${bytes.length} B from block ${block} · ${cid} · verified · ${state.status}`);
  }

  // Fees: local quote next to the runtime's exact estimate.
  const sample = randomBytes(DEMO_CHUNK_BYTES);
  const exact = await estimateStoreFee(api, signer.address, sample);
  console.log(
    `Fee for ${DEMO_CHUNK_BYTES} B: quote ${formatTpot(quoteStoreFee(DEMO_CHUNK_BYTES))} · exact ${formatTpot(exact)} · renew ${formatTpot(quoteRenewFee())}`,
  );

  if (!write) {
    console.log("Read-only run. Pass --write to store, read back and renew.");
  } else {
    const chunks = Array.from({ length: DEMO_CHUNKS }, () => randomBytes(DEMO_CHUNK_BYTES));
    const stored = [];
    for (const [i, chunk] of chunks.entries()) {
      const result = await storeChunk(api, signer.txCreator, chunk, {
        onStage: (stage, d) =>
          console.log(`  chunk ${i}: ${stage}${d.block ? ` #${d.block}` : ""}`),
      });
      const back = await bitswapGet(client, result.cid);
      if (result.cid !== cidOf(back)) throw new Error("read-back CID mismatch");
      console.log(
        `  chunk ${i}: ${result.cid} at ${result.location.block}/${result.location.index}`,
      );
      stored.push(result);
    }
    const first = stored[0];
    if (!first) throw new Error("nothing stored");
    const nonce = await api.apis.AccountNonceApi.account_nonce(signer.address);
    const renewed = await renew(api, signer.txCreator, first.location, { nonce });
    const sameCid = cidFromContentHash(renewed.contentHash) === first.cid;
    console.log(
      `  renewed ${first.cid}: ${first.location.block}/${first.location.index} → ${renewed.location.block}/${renewed.location.index} · same CID ${sameCid}`,
    );
    const path = await writeEvidence(
      `chain-demo-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
      {
        signer: signer.address,
        stores: stored.map((s) => ({
          txHash: s.txHash,
          blockHash: s.blockHash,
          location: s.location,
          cid: s.cid,
          contentHash: toHex(s.contentHash),
        })),
        renew: { txHash: renewed.txHash, from: first.location, to: renewed.location, sameCid },
      },
    );
    console.log(`Saved ${path}`);
  }
} finally {
  destroy();
}
