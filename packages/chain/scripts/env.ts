// Shared helpers for the chain scripts: the repo-root .env and evidence folder.
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";

export const ENV_URL = new URL("../../../.env", import.meta.url);
const EVIDENCE_DIR = new URL("../../../docs/evidence/", import.meta.url);

export function loadRootEnv(): void {
  if (existsSync(ENV_URL)) process.loadEnvFile(ENV_URL);
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set in .env`);
  return value;
}

/** Evidence files are committed so judges and the README can trace every on-chain claim. */
export async function writeEvidence(name: string, data: unknown): Promise<string> {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  const replacer = (_key: string, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value;
  await writeFile(new URL(name, EVIDENCE_DIR), `${JSON.stringify(data, replacer, 2)}\n`);
  return `docs/evidence/${name}`;
}
