// A minimal API client for the walk and guard scripts: cookies, API keys, blob uploads, job
// streams, and the sign-up a dashboard does (wallet sign-in, recovery code, account setup).

import { randomBytes } from "node:crypto";
import {
  addWrap,
  ageRecipient,
  createKeyBundle,
  generateRecoveryCode,
  type KeyBundle,
  recoverySecret,
  recoverySignInKey,
  userKeyPair,
} from "@memdot/crypto";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { SiwsMessage } from "@talismn/siws";
import { AccountId } from "polkadot-api";
import { ownerProofMessage } from "../src/routes/account.js";

export const API = process.env.API_URL ?? "http://localhost:8787";
export const ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:3100";
const FINALIZE_TIMEOUT_MS = 4 * 60_000;

export const hex = (bytes: Uint8Array) => `0x${bytesToHex(bytes)}`;
export const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

export function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(
    `${ok ? "✓" : "✗"} ${label}${ok || detail === undefined ? "" : ` → ${JSON.stringify(detail)}`}`,
  );
  if (!ok) process.exitCode = 1;
}

export interface Declared {
  object: { id: string; cid: string; status: string };
  job: { id: string; status: string };
  uploads: { role: string; index: number; url: string; cid: string }[];
}

export interface CallOptions {
  body?: unknown;
  raw?: Uint8Array;
  headers?: Record<string, string>;
  auth?: "session" | "key";
}

export class Client {
  cookie = "";
  apiKey = "";

  async call<T = Record<string, unknown>>(
    method: string,
    path: string,
    options: CallOptions = {},
  ): Promise<{ status: number; json: T; headers: Headers }> {
    const headers: Record<string, string> = { origin: ORIGIN, ...options.headers };
    if (options.auth === "key") headers.authorization = `Bearer ${this.apiKey}`;
    else if (this.cookie) headers.cookie = this.cookie;
    let body: string | Uint8Array<ArrayBuffer> | undefined;
    if (options.raw) {
      headers["content-type"] = "application/octet-stream";
      body = options.raw as Uint8Array<ArrayBuffer>;
    } else if (options.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(options.body);
    }
    const response = await fetch(`${API}${path}`, { method, headers, body });
    const setCookie = response.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    if (setCookie) this.cookie = setCookie;
    const text = await response.text();
    return {
      status: response.status,
      json: (text ? JSON.parse(text) : {}) as T,
      headers: response.headers,
    };
  }

  /** Declares an object and uploads every blob, the way the SDK will. */
  async upload(
    body: Record<string, unknown>,
    blobs: Map<string, Uint8Array>,
    auth: "session" | "key",
    idempotencyKey?: string,
  ): Promise<Declared> {
    const declared = await this.call<Declared>("POST", "/v1/objects", {
      body,
      auth,
      ...(idempotencyKey ? { headers: { "idempotency-key": idempotencyKey } } : {}),
    });
    if (declared.status !== 202) {
      throw new Error(`declare failed: ${JSON.stringify(declared.json)}`);
    }
    for (const slot of declared.json.uploads) {
      const bytes = blobs.get(slot.cid);
      if (!bytes) throw new Error(`no bytes for ${slot.cid}`);
      const put = await this.call("PUT", slot.url, { raw: bytes, auth });
      if (put.status !== 200) throw new Error(`upload failed: ${JSON.stringify(put.json)}`);
    }
    return declared.json;
  }

  /** Follows a job's SSE stream until it is finalized or failed. */
  async followJob(jobId: string): Promise<{ status: string; seen: string[] }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FINALIZE_TIMEOUT_MS);
    const seen: string[] = [];
    try {
      const response = await fetch(`${API}/v1/jobs/${jobId}/events`, {
        headers: { authorization: `Bearer ${this.apiKey}`, accept: "text/event-stream" },
        signal: controller.signal,
      });
      const reader = response.body?.getReader();
      if (!reader) throw new Error("no event stream");
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (const line of buffer.split("\n")) {
          if (!line.startsWith("data: ")) continue;
          const event = JSON.parse(line.slice(6)) as {
            status: string;
            progress?: { done: number; total: number };
          };
          const label = `${event.status}${event.progress ? ` ${event.progress.done}/${event.progress.total}` : ""}`;
          if (seen.at(-1) !== label) {
            seen.push(label);
            console.log(`  · ${label}`);
          }
          if (event.status === "finalized" || event.status === "failed") {
            return { status: event.status, seen };
          }
        }
        buffer = buffer.slice(buffer.lastIndexOf("\n") + 1);
      }
      return { status: "closed", seen };
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface Onboarded {
  accountMasterKey: Uint8Array;
  bundle: KeyBundle;
  owner: { kind: "substrate"; account: string; signature: string };
  encryptionKey: string;
}

/**
 * What the dashboard does for a new wallet user: SIWS sign-in (signed the way Talisman signs),
 * a master key with its mandatory recovery wrap, the recovery sign-in key, and account setup
 * with the owner proof. The key bundle is left for the caller to store.
 */
export async function onboard(client: Client): Promise<Onboarded> {
  const wallet = sr25519CreateDerive(randomBytes(32))("");
  const address = AccountId(42).dec(wallet.publicKey);
  const { json: nonce } = await client.call<{ nonce: string }>("POST", "/api/auth/siws/nonce", {
    body: {},
  });
  const origin = new URL(ORIGIN);
  const message = new SiwsMessage({
    domain: origin.host,
    uri: origin.origin,
    address,
    nonce: nonce.nonce,
    statement: "Sign in to MemDot",
    chainName: "Portaldot",
    issuedAt: Date.now(),
  }).prepareMessage();
  const signedIn = await client.call("POST", "/api/auth/siws/verify", {
    body: { message, signature: hex(wallet.sign(utf8ToBytes(`<Bytes>${message}</Bytes>`))) },
  });
  check("wallet sign-in", signedIn.status === 200, signedIn.json);

  const code = generateRecoveryCode();
  const { accountMasterKey, bundle } = createKeyBundle();
  const withRecovery = addWrap(
    bundle,
    accountMasterKey,
    { kind: "recovery", id: "recovery" },
    recoverySecret(code),
  );
  const recovery = await client.call("POST", "/api/auth/recovery/register", {
    body: { publicKey: hex(recoverySignInKey(code).publicKey) },
  });
  check("recovery code registered", recovery.status === 200, recovery.json);

  const me = await client.call<{ user: { id: string } }>("GET", "/v1/account");
  const ownerHex = hex(wallet.publicKey);
  const proof = wallet.sign(
    utf8ToBytes(`<Bytes>${ownerProofMessage(me.json.user.id, ownerHex)}</Bytes>`),
  );
  const owner = { kind: "substrate" as const, account: ownerHex, signature: hex(proof) };
  const encryptionKey = ageRecipient(userKeyPair(accountMasterKey).publicKey);
  const setup = await client.call("PUT", "/v1/account", { body: { owner, encryptionKey } });
  check("account set up with owner proof", setup.status === 200, setup.json);
  return { accountMasterKey, bundle: withRecovery, owner, encryptionKey };
}
