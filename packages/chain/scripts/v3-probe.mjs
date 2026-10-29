// Read-only probe of the Portaldot V3 testnet runtime.
// Records what the storage and contract pallets expose so design decisions rest on live metadata.
// Usage: pnpm probe [wss-endpoint]
import { mkdir, writeFile } from "node:fs/promises";
import { ApiPromise, WsProvider } from "@polkadot/api";

const ENDPOINT = process.argv[2] ?? "wss://test-node-v3.portaldot.dev";
const PALLETS = ["transactionStorage", "revive", "contracts"];

const api = await ApiPromise.create({ provider: new WsProvider(ENDPOINT), noInitWarn: true });

const [chain, version, properties, header] = await Promise.all([
  api.rpc.system.chain(),
  api.rpc.system.version(),
  api.rpc.system.properties(),
  api.rpc.chain.getHeader(),
]);

const runtime = api.runtimeVersion;
const report = {
  probedAt: new Date().toISOString(),
  endpoint: ENDPOINT,
  chain: chain.toString(),
  nodeVersion: version.toString(),
  specName: runtime.specName.toString(),
  specVersion: runtime.specVersion.toNumber(),
  bestBlock: header.number.toNumber(),
  // Needed to turn block-denominated limits (e.g. retentionPeriod) into wall-clock time.
  blockTimeMs:
    api.consts.babe?.expectedBlockTime?.toNumber() ??
    api.consts.timestamp.minimumPeriod.toNumber() * 2,
  properties: properties.toHuman(),
  palletCount: api.runtimeMetadata.asLatest.pallets.length,
  pallets: {},
};

for (const name of PALLETS) {
  if (!api.tx[name]) {
    report.pallets[name] = { present: false };
    continue;
  }
  const calls = Object.fromEntries(
    Object.entries(api.tx[name]).map(([call, fn]) => [
      call,
      fn.meta.args.map((arg) => `${arg.name.toString()}: ${arg.type.toString()}`),
    ]),
  );
  const constants = Object.fromEntries(
    Object.entries(api.consts[name] ?? {}).map(([key, value]) => [key, value.toHuman()]),
  );
  // Plain (non-map) storage values can be read directly; maps are only listed.
  const storage = {};
  for (const [key, query] of Object.entries(api.query[name] ?? {})) {
    storage[key] = query.creator.meta.type.isPlain ? (await query()).toHuman() : "(map)";
  }
  report.pallets[name] = { present: true, calls, constants, storage };
}

await api.disconnect();

// Evidence lives at the repo root so the README can link it, wherever this script runs from.
const evidenceDir = new URL("../../../docs/evidence/", import.meta.url);
const day = report.probedAt.slice(0, 10);
await mkdir(evidenceDir, { recursive: true });
await writeFile(
  new URL(`v3-probe-${day}.json`, evidenceDir),
  `${JSON.stringify(report, null, 2)}\n`,
);

console.log(
  `${report.chain} · ${report.specName} v${report.specVersion} · block #${report.bestBlock} · ${report.blockTimeMs} ms blocks · ${report.palletCount} pallets`,
);
for (const [name, info] of Object.entries(report.pallets)) {
  console.log(`\n${name}: ${info.present ? "present" : "MISSING"}`);
  if (!info.present) continue;
  console.log(`  calls:     ${Object.keys(info.calls).join(", ")}`);
  console.log(`  constants: ${JSON.stringify(info.constants)}`);
  console.log(`  storage:   ${JSON.stringify(info.storage)}`);
}
console.log(`\nSaved docs/evidence/v3-probe-${day}.json (repo root)`);
