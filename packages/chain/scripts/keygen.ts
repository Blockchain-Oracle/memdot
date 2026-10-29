// Creates the relayer/keeper signing account (sr25519, testnet only) and stores its mnemonic in the
// repo-root .env. The mnemonic is never printed; only the public address is shown.
import { readFile, writeFile } from "node:fs/promises";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { signerFromMnemonic } from "../src/signer.js";
import { ENV_URL } from "./env.js";

const MNEMONIC_STRENGTH_BITS = 256;

let env = "";
try {
  env = await readFile(ENV_URL, "utf8");
} catch {
  env = "";
}

let mnemonic = env.match(/^SIGNER_MNEMONIC=(.+)$/m)?.[1]?.trim();
if (!mnemonic) {
  mnemonic = generateMnemonic(wordlist, MNEMONIC_STRENGTH_BITS);
  const line = `SIGNER_MNEMONIC=${mnemonic}`;
  env = /^SIGNER_MNEMONIC=.*$/m.test(env)
    ? env.replace(/^SIGNER_MNEMONIC=.*$/m, line)
    : `${env}${env && !env.endsWith("\n") ? "\n" : ""}${line}\n`;
  await writeFile(ENV_URL, env, { mode: 0o600 });
  console.log("Generated a new signer mnemonic and saved it to .env");
} else {
  console.log("Using the existing signer mnemonic from .env");
}

console.log(`Signer address: ${signerFromMnemonic(mnemonic).address}`);
