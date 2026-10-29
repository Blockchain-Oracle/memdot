import { existsSync } from "node:fs";
import { PORTALDOT_EVM_RPC, PORTALDOT_WSS, TPOT_DECIMALS } from "@memdot/config";
import { z } from "zod";

// In development the repo-root .env is the single source; in production Coolify injects env.
const rootEnv = new URL("../../../.env", import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const tpot = (value: number) =>
  BigInt(Math.round(value * 10 ** 4)) * 10n ** BigInt(TPOT_DECIMALS - 4);

const schema = z.object({
  DATABASE_URL: z.url(),
  /** The relayer and keeper account (sr25519). Testnet only; never committed. */
  SIGNER_MNEMONIC: z.string().min(1),
  PORTALDOT_WSS: z.string().default(PORTALDOT_WSS),
  PORTALDOT_EVM_RPC: z.url().default(PORTALDOT_EVM_RPC),
  /** MemDotRegistry address once deployed; the indexer follows its logs when set. */
  REGISTRY_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
  /** Below this free balance new stores pause (renewals continue) and ops get an alert. */
  LOW_BALANCE_TPOT: z.coerce.number().positive().default(2),
  /** Override when the keeper renews (blocks since the last store/renew), e.g. to force a renewal in a test. */
  KEEPER_RENEW_AFTER_BLOCKS: z.coerce.number().int().positive().optional(),
  /** Where the indexer starts on a fresh database. Defaults to one hour before the head. */
  INDEXER_START_BLOCK: z.coerce.number().int().positive().optional(),
  /** Discord webhook for ops alerts (low balance, renewal at risk, lost items). */
  DISCORD_ALERT_WEBHOOK_URL: z.url().optional(),
});

const parsed = schema.parse(process.env);

export const env = { ...parsed, lowBalancePlanck: tpot(parsed.LOW_BALANCE_TPOT) };
export type Env = typeof env;
