import { ed25519 } from "@noble/curves/ed25519.js";
import { generateMnemonic, mnemonicToEntropy, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { deriveKey, INFO } from "./keys.js";

/** 128 bits → 12 BIP39 words with a built-in checksum, so typos are caught before unlocking. */
const RECOVERY_STRENGTH_BITS = 128;

export function generateRecoveryCode(): string {
  return generateMnemonic(wordlist, RECOVERY_STRENGTH_BITS);
}

export function normalizeRecoveryCode(code: string): string {
  return code.trim().toLowerCase().split(/\s+/).join(" ");
}

export function isValidRecoveryCode(code: string): boolean {
  return validateMnemonic(normalizeRecoveryCode(code), wordlist);
}

/** The unlock secret for the recovery wrap in the key bundle. */
export function recoverySecret(code: string): Uint8Array {
  const normalized = normalizeRecoveryCode(code);
  if (!validateMnemonic(normalized, wordlist)) throw new Error("recovery code checksum failed");
  return mnemonicToEntropy(normalized, wordlist);
}

/**
 * Ed25519 key for signing in with the recovery code alone (new browser, no passkey). Only its
 * public key is stored server-side; the account key bundle still needs the same code to open.
 */
export function recoverySignInKey(code: string): { secretKey: Uint8Array; publicKey: Uint8Array } {
  const secretKey = deriveKey(recoverySecret(code), INFO.recoverySignIn);
  return { secretKey, publicKey: ed25519.getPublicKey(secretKey) };
}

export function signRecoveryChallenge(code: string, challenge: Uint8Array): Uint8Array {
  return ed25519.sign(challenge, recoverySignInKey(code).secretKey);
}

export function verifyRecoveryChallenge(
  publicKey: Uint8Array,
  challenge: Uint8Array,
  signature: Uint8Array,
): boolean {
  return ed25519.verify(signature, challenge, publicKey);
}
