import {
  ageIdentity,
  ageRecipient,
  deriveKey,
  openWith,
  sealTo,
  x25519FromSeed,
} from "@memdot/crypto";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { managedNonce } from "@noble/ciphers/utils.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

const INFO = {
  rows: "memdot/assisted-rows/v1",
  terms: "memdot/assisted-terms/v1",
  segments: "memdot/assisted-segments/v1",
  account: "memdot/assisted-account/v1",
} as const;

/** Bytes of a keyed term hash kept: enough that two terms in a namespace never collide. */
const TERM_BYTES = 12;

const seal = (key: Uint8Array, plaintext: Uint8Array, aad: string) =>
  managedNonce(xchacha20poly1305)(key, utf8ToBytes(aad)).encrypt(plaintext);
const open = (key: Uint8Array, sealed: Uint8Array, aad: string) =>
  managedNonce(xchacha20poly1305)(key, utf8ToBytes(aad)).decrypt(sealed);

/**
 * What the server may read, and how. Every Assisted namespace has its own keys, derived from one
 * secret kept only in the service's environment: nothing to store, and the database alone opens
 * nothing. Private namespaces have no keys here at all.
 */
export class AssistedKeys {
  private readonly secret: Uint8Array;

  constructor(secret: string) {
    this.secret = utf8ToBytes(secret);
  }

  private derive(info: string, id: string): Uint8Array {
    return deriveKey(this.secret, `${info}/${id}`);
  }

  /** Seals what a row holds (text, history, queued writes), bound to its namespace. */
  sealRow(folderId: string, plaintext: Uint8Array): Uint8Array {
    return seal(this.derive(INFO.rows, folderId), plaintext, folderId);
  }

  openRow(folderId: string, sealed: Uint8Array): Uint8Array {
    return open(this.derive(INFO.rows, folderId), sealed, folderId);
  }

  sealRowText(folderId: string, text: string): Uint8Array {
    return this.sealRow(folderId, utf8ToBytes(text));
  }

  openRowText(folderId: string, sealed: Uint8Array): string {
    return new TextDecoder().decode(this.openRow(folderId, sealed));
  }

  /** An account's own provider keys. */
  sealForAccount(accountId: string, secret: string): Uint8Array {
    return seal(this.derive(INFO.account, accountId), utf8ToBytes(secret), accountId);
  }

  openForAccount(accountId: string, sealed: Uint8Array): string {
    return new TextDecoder().decode(open(this.derive(INFO.account, accountId), sealed, accountId));
  }

  /** A keyed hash of a keyword: equal words match within a namespace and nowhere else. */
  blindTerm(folderId: string, term: string): string {
    return bytesToHex(
      hmac(sha256, this.derive(INFO.terms, folderId), utf8ToBytes(term)).slice(0, TERM_BYTES),
    );
  }

  private segmentKeys(folderId: string) {
    return x25519FromSeed(this.derive(INFO.segments, folderId), folderId);
  }

  /**
   * Seals a segment for the chain. Two recipients: this namespace's server key and the owner's own
   * sharing key, so the owner can read every Assisted memory without MemDot.
   */
  sealSegment(folderId: string, ownerRecipient: string, bytes: Uint8Array): Promise<Uint8Array> {
    const server = ageRecipient(this.segmentKeys(folderId).publicKey);
    return sealTo(bytes, [server, ownerRecipient]);
  }

  openSegment(folderId: string, sealed: Uint8Array): Promise<Uint8Array> {
    return openWith(sealed, ageIdentity(this.segmentKeys(folderId).secretKey), "the segment");
  }
}
