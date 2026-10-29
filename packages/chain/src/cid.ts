import { CID_PREFIX } from "@memdot/config";
import { blake2b } from "@noble/hashes/blake2.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { base32nopad } from "@scure/base";

const CONTENT_HASH_BYTES = 32;
/** Multibase prefix for lowercase base32 without padding. */
const MULTIBASE_BASE32 = "b";

/** TransactionStorage records blake2b-256 of the stored bytes as `content_hash`. */
export function contentHash(data: Uint8Array): Uint8Array {
  return blake2b(data, { dkLen: CONTENT_HASH_BYTES });
}

export function cidFromContentHash(hash: Uint8Array): string {
  if (hash.length !== CONTENT_HASH_BYTES) {
    throw new Error(`content hash must be ${CONTENT_HASH_BYTES} bytes, got ${hash.length}`);
  }
  const bytes = new Uint8Array(CID_PREFIX.length + hash.length);
  bytes.set(CID_PREFIX);
  bytes.set(hash, CID_PREFIX.length);
  return MULTIBASE_BASE32 + base32nopad.encode(bytes).toLowerCase();
}

export function cidOf(data: Uint8Array): string {
  return cidFromContentHash(contentHash(data));
}

export function contentHashFromCid(cid: string): Uint8Array {
  if (!cid.startsWith(MULTIBASE_BASE32)) throw new Error(`unsupported multibase in CID ${cid}`);
  const bytes = base32nopad.decode(cid.slice(1).toUpperCase());
  const prefix = bytes.subarray(0, CID_PREFIX.length);
  if (!prefix.every((byte, i) => byte === CID_PREFIX[i])) {
    throw new Error(`CID ${cid} is not a raw blake2b-256 TransactionStorage CID`);
  }
  return bytes.slice(CID_PREFIX.length);
}

/** PAPI returns fixed-size binaries as 0x-hex strings; accept either form. */
export function toBytes(value: Uint8Array | string): Uint8Array {
  return typeof value === "string" ? hexToBytes(value.replace(/^0x/, "")) : value;
}

export function toHex(bytes: Uint8Array): `0x${string}` {
  return `0x${bytesToHex(bytes)}`;
}
