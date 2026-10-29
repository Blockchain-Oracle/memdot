import { existsSync } from "node:fs";
import { DEFAULT_MAX_FILE_BYTES, PORTALDOT_WSS, SPONSORED_QUOTA_BYTES } from "@memdot/config";
import { z } from "zod";

// In development the repo-root .env is the single source; in production Coolify injects env.
const rootEnv = new URL("../../../.env", import.meta.url);
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const schema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8787),
  DATABASE_URL: z.url(),
  /** Signs session cookies and encrypts auth secrets. 32+ random bytes, base64. */
  BETTER_AUTH_SECRET: z.string().min(32),
  /** Public base URL of this API (Better Auth builds callback URLs from it). */
  API_URL: z.url().default("http://localhost:8787"),
  /** The dashboard origin: CORS, passkey ceremonies and wallet sign-in messages must match it. */
  WEB_ORIGIN: z.url().default("http://localhost:3000"),
  /** WebAuthn relying-party id. `memdot.xyz` in production so passkeys work on every subdomain. */
  RP_ID: z.string().min(1).default("localhost"),
  /** Parent domain for cookies shared by app. and api. in production; unset on localhost. */
  COOKIE_DOMAIN: z.string().optional(),
  /**
   * Reverse proxies (IPs or CIDR ranges, comma-separated) whose X-Forwarded-For entries are
   * trusted. Unset: the socket address is the client, and X-Forwarded-For is ignored.
   */
  TRUSTED_PROXIES: z
    .string()
    .optional()
    .transform((value) =>
      (value ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  PORTALDOT_WSS: z.string().default(PORTALDOT_WSS),
  /** Ciphertext bytes a new sponsored space may hold (the relayer pays for it). */
  SPONSORED_QUOTA_BYTES: z.coerce.number().int().positive().default(SPONSORED_QUOTA_BYTES),
  /** Largest single object (all chunks plus its manifest). */
  MAX_FILE_BYTES: z.coerce.number().int().positive().default(DEFAULT_MAX_FILE_BYTES),
  /** Where the CID gateway keeps ciphertext it fetched from the chain. */
  GATEWAY_CACHE_DIR: z.string().default(".cache/gateway"),
});

export type Env = z.infer<typeof schema>;

export const env: Env = schema.parse(process.env);
export const isProduction = env.NODE_ENV === "production";
