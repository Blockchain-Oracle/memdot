// Deploys MemDotRegistry natively with Revive.instantiate_with_code from the relayer account.
// Always dry-runs first; submits only with --write. Run `forge build` before this script.
// Usage: pnpm --filter @memdot/contracts deploy [--write] [--origin <ss58>]
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createChainClient, formatTpot, signerFromMnemonic } from "@memdot/chain";
import { hexToBytes } from "viem";

const HEADROOM_PERCENT = 120n;
const withHeadroom = (value: bigint) => (value * HEADROOM_PERCENT) / 100n;

const envUrl = new URL("../../../.env", import.meta.url);
if (existsSync(envUrl)) process.loadEnvFile(envUrl);
const mnemonic = process.env.SIGNER_MNEMONIC;
if (!mnemonic) throw new Error("SIGNER_MNEMONIC is not set in .env");

const write = process.argv.includes("--write");
const originFlag = process.argv.indexOf("--origin");
const signer = signerFromMnemonic(mnemonic);
const { api, destroy } = createChainClient();

try {
  const artifact = JSON.parse(
    await readFile(
      new URL("../out/MemDotRegistry.sol/MemDotRegistry.json", import.meta.url),
      "utf8",
    ),
  ) as { bytecode: { object: `0x${string}` } };
  const code = hexToBytes(artifact.bytecode.object);
  const origin = originFlag > 0 ? (process.argv[originFlag + 1] ?? signer.address) : signer.address;

  const dry = await api.apis.ReviveApi.instantiate(
    origin,
    0n,
    undefined,
    undefined,
    { type: "Upload", value: code },
    new Uint8Array(),
    undefined,
  );
  if (!dry.result.success) throw new Error(`dry-run failed: ${JSON.stringify(dry.result.value)}`);
  const deposit = dry.max_storage_deposit.type === "Charge" ? dry.max_storage_deposit.value : 0n;
  console.log(`Dry-run as ${origin}: code ${code.length} B accepted`);
  console.log(
    `  address ${dry.result.value.addr} · weight ${dry.weight_required.ref_time}/${dry.weight_required.proof_size} · max deposit ${formatTpot(deposit)}`,
  );

  if (!write) {
    console.log("Dry run only. Pass --write to deploy from the relayer account.");
  } else {
    const tx = api.tx.Revive.instantiate_with_code({
      value: 0n,
      weight_limit: {
        ref_time: withHeadroom(dry.weight_required.ref_time),
        proof_size: withHeadroom(dry.weight_required.proof_size),
      },
      storage_deposit_limit: withHeadroom(deposit),
      code,
      data: new Uint8Array(),
      salt: undefined,
    });
    const result = await tx.createAndSubmit(signer.txCreator);
    if (!result.ok) throw new Error(`deploy failed: ${JSON.stringify(result.dispatchError)}`);
    const [instantiated] = api.event.Revive.Instantiated.filter(result.events);
    const deployment = {
      network: "portaldot-v3-testnet",
      address: instantiated?.payload.contract ?? dry.result.value.addr,
      deployer: signer.address,
      txHash: result.txHash,
      block: result.block.number,
      deployedAt: new Date().toISOString(),
    };
    const dir = new URL("../deployments/", import.meta.url);
    await mkdir(dir, { recursive: true });
    await writeFile(new URL("portaldot-v3.json", dir), `${JSON.stringify(deployment, null, 2)}\n`);
    console.log(`Deployed MemDotRegistry at ${deployment.address} in block ${deployment.block}`);
  }
} finally {
  destroy();
}
