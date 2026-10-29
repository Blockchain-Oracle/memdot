// Creates the relayer/keeper signing account (sr25519, testnet only) and stores its mnemonic in the
// repo-root .env. The mnemonic is never printed; only the public address is shown.
import { readFile, writeFile } from "node:fs/promises";
import { Keyring } from "@polkadot/keyring";
import { cryptoWaitReady, mnemonicGenerate } from "@polkadot/util-crypto";

const SS58_PREFIX = 42;
const envPath = new URL("../../../.env", import.meta.url);

await cryptoWaitReady();

let env = "";
try {
  env = await readFile(envPath, "utf8");
} catch {
  env = "";
}

let mnemonic = env.match(/^SIGNER_MNEMONIC=(.+)$/m)?.[1]?.trim();
if (!mnemonic) {
  mnemonic = mnemonicGenerate(24);
  const line = `SIGNER_MNEMONIC=${mnemonic}`;
  env = /^SIGNER_MNEMONIC=.*$/m.test(env)
    ? env.replace(/^SIGNER_MNEMONIC=.*$/m, line)
    : `${env}${env && !env.endsWith("\n") ? "\n" : ""}${line}\n`;
  await writeFile(envPath, env, { mode: 0o600 });
  console.log("Generated a new signer mnemonic and saved it to .env");
} else {
  console.log("Using the existing signer mnemonic from .env");
}

const pair = new Keyring({ type: "sr25519", ss58Format: SS58_PREFIX }).addFromMnemonic(mnemonic);
console.log(`Signer address (SS58 ${SS58_PREFIX}): ${pair.address}`);
