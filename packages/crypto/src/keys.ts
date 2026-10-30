import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { bech32 } from "@scure/base";

export const KEY_BYTES = 32;
/** age encodes keys as bech32 with no length cap in practice; 1023 is bech32's documented maximum. */
const BECH32_LIMIT = 1023;

/** Domain-separation labels. Changing one changes every derived key, so they carry a version. */
export const INFO = {
  user: "memdot/user-x25519/v1",
  object: "memdot/object-x25519/v1",
  space: "memdot/space-x25519/v1",
  spaceKey: "memdot/space-key/v1",
  recoverySignIn: "memdot/recovery-signin-ed25519/v1",
  owner: "memdot/owner-sr25519/v1",
} as const;

export interface X25519KeyPair {
  secretKey: Uint8Array;
  publicKey: Uint8Array;
}

export function randomKey(): Uint8Array {
  return randomBytes(KEY_BYTES);
}

export function deriveKey(ikm: Uint8Array, info: string, salt?: Uint8Array): Uint8Array {
  return hkdf(sha256, ikm, salt, utf8ToBytes(info), KEY_BYTES);
}

/** Deterministic X25519 pair from a symmetric seed, so holding the seed is holding the identity. */
export function x25519FromSeed(seed: Uint8Array, info: string): X25519KeyPair {
  const secretKey = deriveKey(seed, info);
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

export function generateX25519(): X25519KeyPair {
  const { secretKey, publicKey } = x25519.keygen();
  return { secretKey, publicKey };
}

/** The user's sharing key: anyone can encrypt to its public half, published in the registry. */
export function userKeyPair(accountMasterKey: Uint8Array): X25519KeyPair {
  return x25519FromSeed(accountMasterKey, INFO.user);
}

/**
 * The chain-account seed for accounts without a wallet (passkey or recovery-code sign-up): an
 * sr25519 mini secret only the master key can produce, so the account owns a chain identity
 * without storing another secret.
 */
export function ownerSeed(accountMasterKey: Uint8Array): Uint8Array {
  return deriveKey(accountMasterKey, INFO.owner);
}

/** The account's age recipient: what others seal shares to (its `encryptionKey`). */
export function userRecipient(accountMasterKey: Uint8Array): string {
  return ageRecipient(userKeyPair(accountMasterKey).publicKey);
}

/** The account's age identity: opens anything shared with it. */
export function userIdentity(accountMasterKey: Uint8Array): string {
  return ageIdentity(userKeyPair(accountMasterKey).secretKey);
}

export function ageRecipient(publicKey: Uint8Array): string {
  return bech32.encode("age", bech32.toWords(publicKey), BECH32_LIMIT);
}

export function ageIdentity(secretKey: Uint8Array): string {
  return bech32.encode("age-secret-key-", bech32.toWords(secretKey), BECH32_LIMIT).toUpperCase();
}

export function publicKeyFromAgeRecipient(recipient: string): Uint8Array {
  const { prefix, words } = bech32.decode(recipient as `${string}1${string}`, BECH32_LIMIT);
  if (prefix !== "age") throw new Error(`not an age recipient: ${recipient}`);
  return bech32.fromWords(words);
}
