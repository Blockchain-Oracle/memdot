// Walks the wallet (SIWS) and recovery-code sign-ins against a running local API, the way the
// dashboard will: a Talisman-style `<Bytes>`-wrapped signature, then a recovery key registered
// with the fresh session and used to sign in again. Also checks the passkey PRF guard.
// Usage: pnpm --filter @memdot/api dev, then pnpm --filter @memdot/api smoke:auth

import { randomBytes } from "node:crypto";
import { generateRecoveryCode, recoverySignInKey, signRecoveryChallenge } from "@memdot/crypto";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { SiwsMessage } from "@talismn/siws";
import { AccountId } from "polkadot-api";

const API = process.env.API_URL ?? "http://localhost:8787";
const ORIGIN = process.env.WEB_ORIGIN ?? "http://localhost:3000";

const hex = (bytes: Uint8Array) => `0x${bytesToHex(bytes)}`;

/** The fields these auth endpoints answer with. */
interface Reply {
  nonce?: string;
  challenge?: string;
  code?: string;
  user?: { id?: string };
}

async function post(path: string, body: unknown, cookie?: string) {
  const response = await fetch(`${API}/api/auth${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  });
  const cookies = response.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return { status: response.status, json: (await response.json()) as Reply, cookies };
}

function check(label: string, ok: boolean, detail?: unknown) {
  console.log(
    `${ok ? "✓" : "✗"} ${label}${ok || detail === undefined ? "" : ` → ${JSON.stringify(detail)}`}`,
  );
  if (!ok) process.exitCode = 1;
}

async function siwsSignIn(keyPair: ReturnType<ReturnType<typeof sr25519CreateDerive>>) {
  const address = AccountId(42).dec(keyPair.publicKey);
  const { json } = await post("/siws/nonce", {});
  const origin = new URL(ORIGIN);
  const message = new SiwsMessage({
    domain: origin.host,
    uri: origin.origin,
    address,
    nonce: json.nonce ?? "",
    statement: "Sign in to MemDot",
    chainName: "Portaldot",
    issuedAt: Date.now(),
    expirationTime: Date.now() + 5 * 60_000,
  }).prepareMessage();
  // Extensions sign `<Bytes>${message}</Bytes>` through signRaw.
  const signature = keyPair.sign(utf8ToBytes(`<Bytes>${message}</Bytes>`));
  return post("/siws/verify", { message, signature: hex(signature), name: "Smoke wallet" });
}

const wallet = sr25519CreateDerive(randomBytes(32))("");

const first = await siwsSignIn(wallet);
check("SIWS creates an account and a session", first.status === 200 && !!first.cookies, first.json);
const again = await siwsSignIn(wallet);
check(
  "SIWS signs the same wallet into the same account",
  again.json.user?.id === first.json.user?.id,
  again.json,
);

const replay = await post("/siws/verify", {
  message: "garbage",
  signature: `0x${"00".repeat(64)}`,
});
check("a malformed SIWS message is refused", replay.status === 400, replay.json);

const code = generateRecoveryCode();
const recoveryKey = recoverySignInKey(code);
const registered = await post(
  "/recovery/register",
  { publicKey: hex(recoveryKey.publicKey) },
  first.cookies,
);
check("the fresh session registers a recovery key", registered.status === 200, registered.json);

const { json: challenge } = await post("/recovery/challenge", {});
const signed = signRecoveryChallenge(code, utf8ToBytes(challenge.challenge ?? ""));
const recovered = await post("/recovery/verify", {
  publicKey: hex(recoveryKey.publicKey),
  challenge: challenge.challenge,
  signature: hex(signed),
});
check(
  "the recovery code signs in to the same account",
  recovered.json.user?.id === first.json.user?.id,
  recovered.json,
);

const reused = await post("/recovery/verify", {
  publicKey: hex(recoveryKey.publicKey),
  challenge: challenge.challenge,
  signature: hex(signed),
});
check("a used recovery challenge cannot be replayed", reused.status === 401, reused.json);

const wrongCode = generateRecoveryCode();
const { json: challenge2 } = await post("/recovery/challenge", {});
const wrong = await post("/recovery/verify", {
  publicKey: hex(recoverySignInKey(wrongCode).publicKey),
  challenge: challenge2.challenge,
  signature: hex(signRecoveryChallenge(wrongCode, utf8ToBytes(challenge2.challenge ?? ""))),
});
check("an unknown recovery code is refused", wrong.status === 401, wrong.json);

const prf = await post("/passkey/verify-authentication", {
  response: {
    id: "x",
    rawId: "x",
    type: "public-key",
    response: {},
    clientExtensionResults: { prf: { results: { first: "AAAA" } } },
  },
});
check(
  "a passkey response carrying PRF output is refused",
  prf.json.code === "PRF_OUTPUT_SENT",
  prf.json,
);
