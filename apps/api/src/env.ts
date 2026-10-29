import { existsSync } from "node:fs";
import { PORTALDOT_WSS } from "@memdot/config";
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
  PORTALDOT_WSS: z.string().default(PORTALDOT_WSS),
});

export type Env = z.infer<typeof schema>;

export const env: Env = schema.parse(process.env);
export const isProduction = env.NODE_ENV === "production";
