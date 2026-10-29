import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { managedNonce } from "@noble/ciphers/utils.js";
import { randomBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { base64 } from "@scure/base";
import { WrongKeyError } from "./errors.js";
import { deriveKey, KEY_BYTES, randomKey } from "./keys.js";

/**
 * The account master key (AMK) is random and never derived from a login method. Each unlock
 * method (passkey PRF, wallet signVrf, recovery code) only wraps it, so adding or losing one
 * method never changes the data keys. Wraps use audited noble primitives, not age.
 */
export type UnlockKind = "passkey" | "vrf" | "recovery";

const KEK_INFO: Record<UnlockKind, string> = {
  passkey: "memdot/kek/passkey/v1",
  vrf: "memdot/kek/vrf/v1",
  recovery: "memdot/kek/recovery/v1",
};

/** PRF inputs are bound to this label and the wrap's salt (same idea as age's fido2prf). */
const PRF_LABEL = "memdot/prf/v1";
const SALT_BYTES = 32;

export interface KeyWrap {
  kind: UnlockKind;
  /** Passkey credential id, wallet address, or "recovery". */
  id: string;
  salt: string;
  ciphertext: string;
}

export interface KeyBundle {
  v: 1;
  wraps: KeyWrap[];
}

function wrapCipher(
  unlockSecret: Uint8Array,
  wrap: Pick<KeyWrap, "kind" | "id">,
  salt: Uint8Array,
) {
  const kek = deriveKey(unlockSecret, KEK_INFO[wrap.kind], salt);
  const aad = utf8ToBytes(`memdot/key-bundle/v1|${wrap.kind}|${wrap.id}`);
  return managedNonce(xchacha20poly1305)(kek, aad);
}

export function newSalt(): Uint8Array {
  return randomBytes(SALT_BYTES);
}

/** WebAuthn PRF eval inputs for a wrap; two inputs so one user presence opens one wrap only. */
export function prfInputs(salt: Uint8Array): { first: Uint8Array; second: Uint8Array } {
  const label = utf8ToBytes(PRF_LABEL);
  const input = (n: number) => Uint8Array.from([...label, n, ...salt]);
  return { first: input(1), second: input(2) };
}

/** Combines the PRF results into the passkey's unlock secret. */
export function passkeySecret(first: Uint8Array, second: Uint8Array): Uint8Array {
  return Uint8Array.from([...first, ...second]);
}

export function createKeyBundle(): { accountMasterKey: Uint8Array; bundle: KeyBundle } {
  return { accountMasterKey: randomKey(), bundle: { v: 1, wraps: [] } };
}

export function addWrap(
  bundle: KeyBundle,
  accountMasterKey: Uint8Array,
  wrap: Pick<KeyWrap, "kind" | "id">,
  unlockSecret: Uint8Array,
  salt: Uint8Array = newSalt(),
): KeyBundle {
  const ciphertext = wrapCipher(unlockSecret, wrap, salt).encrypt(accountMasterKey);
  const next = bundle.wraps.filter((w) => !(w.kind === wrap.kind && w.id === wrap.id));
  next.push({ ...wrap, salt: base64.encode(salt), ciphertext: base64.encode(ciphertext) });
  return { v: 1, wraps: next };
}

export function removeWrap(bundle: KeyBundle, kind: UnlockKind, id: string): KeyBundle {
  if (kind === "recovery")
    throw new Error("the recovery code wrap is mandatory; regenerate it instead");
  const wraps = bundle.wraps.filter((w) => !(w.kind === kind && w.id === id));
  if (wraps.length === 0) throw new Error("cannot remove the last unlock method");
  return { v: 1, wraps };
}

/** Tries every wrap of the given kind (optionally one id) and returns the AMK. */
export function unwrapMasterKey(
  bundle: KeyBundle,
  kind: UnlockKind,
  unlockSecret: Uint8Array,
  id?: string,
): Uint8Array {
  for (const wrap of bundle.wraps) {
    if (wrap.kind !== kind || (id !== undefined && wrap.id !== id)) continue;
    try {
      const amk = wrapCipher(unlockSecret, wrap, base64.decode(wrap.salt)).decrypt(
        base64.decode(wrap.ciphertext),
      );
      if (amk.length === KEY_BYTES) return amk;
    } catch {
      // Authentication failed for this wrap; try the next one.
    }
  }
  throw new WrongKeyError("the key bundle");
}

export function serializeKeyBundle(bundle: KeyBundle): Uint8Array {
  return utf8ToBytes(JSON.stringify(bundle));
}

export function parseKeyBundle(bytes: Uint8Array): KeyBundle {
  const bundle = JSON.parse(new TextDecoder().decode(bytes)) as KeyBundle;
  if (bundle.v !== 1 || !Array.isArray(bundle.wraps)) throw new Error("unsupported key bundle");
  return bundle;
}
