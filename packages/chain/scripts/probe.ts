// Read-only check of the Portaldot V3 runtime facts MemDot depends on. Run it after any runtime
// upgrade: if a value here changes, packages/config/src/chain.ts must change with it.
import { createChainClient } from "../src/client.js";
import { writeEvidence } from "./env.js";

const { client, api, destroy } = createChainClient(process.argv[2]);

try {
  const [spec, head, version, blockTime] = await Promise.all([
    client.getChainSpecData(),
    client.getFinalizedBlock(),
    api.constants.System.Version(),
    api.constants.Babe.ExpectedBlockTime(),
  ]);
  const report = {
    probedAt: new Date().toISOString(),
    chain: spec.name,
    genesisHash: spec.genesisHash,
    specName: version.spec_name,
    specVersion: version.spec_version,
    finalizedBlock: head.number,
    blockTimeMs: blockTime,
    transactionStorage: {
      maxTransactionSize: await api.constants.TransactionStorage.MaxTransactionSize(),
      maxBlockTransactions: await api.constants.TransactionStorage.MaxBlockTransactions(),
      retentionPeriod: await api.query.TransactionStorage.RetentionPeriod.getValue(),
      byteFee: await api.query.TransactionStorage.ByteFee.getValue(),
      entryFee: await api.query.TransactionStorage.EntryFee.getValue(),
    },
    revive: {
      chainId: await api.constants.Revive.ChainId(),
      allowEvmBytecode: await api.constants.Revive.AllowEVMBytecode(),
      autoMap: await api.constants.Revive.AutoMap(),
      nativeToEthRatio: await api.constants.Revive.NativeToEthRatio(),
    },
  };
  const day = report.probedAt.slice(0, 10);
  const path = await writeEvidence(`v3-runtime-${day}.json`, report);
  console.log(
    `${report.chain} · ${report.specName} v${report.specVersion} · block #${head.number}`,
  );
  console.log(
    JSON.stringify(report.transactionStorage, (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    ),
  );
  console.log(`Saved ${path}`);
} finally {
  destroy();
}
