import { CHUNK_BYTES } from "@memdot/config";
import { openWith, sealTo } from "./age.js";
import { ageIdentity, ageRecipient, INFO, randomKey, x25519FromSeed } from "./keys.js";
import { padmeLength, padTo } from "./padding.js";

/**
 * A file is encrypted once as a single age stream (so truncation and reordering are detected)
 * and the ciphertext is then cut into storage chunks of at most CHUNK_BYTES.
 */
export interface EncryptedObject {
  /** Random per-object key; it lives only inside the encrypted manifest. */
  objectKey: Uint8Array;
  chunks: Uint8Array[];
  size: number;
  paddedSize: number;
}

export function objectRecipient(objectKey: Uint8Array): string {
  return ageRecipient(x25519FromSeed(objectKey, INFO.object).publicKey);
}

export function objectIdentity(objectKey: Uint8Array): string {
  return ageIdentity(x25519FromSeed(objectKey, INFO.object).secretKey);
}

export function splitChunks(data: Uint8Array, chunkBytes: number = CHUNK_BYTES): Uint8Array[] {
  if (chunkBytes <= 0) throw new Error("chunk size must be positive");
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < data.length; offset += chunkBytes) {
    chunks.push(data.subarray(offset, Math.min(offset + chunkBytes, data.length)));
  }
  return chunks.length > 0 ? chunks : [new Uint8Array(0)];
}

export function joinChunks(chunks: Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}

export async function encryptObject(
  plaintext: Uint8Array,
  chunkBytes: number = CHUNK_BYTES,
): Promise<EncryptedObject> {
  const objectKey = randomKey();
  const paddedSize = padmeLength(plaintext.length);
  const ciphertext = await sealTo(padTo(plaintext, paddedSize), [objectRecipient(objectKey)]);
  return {
    objectKey,
    chunks: splitChunks(ciphertext, chunkBytes),
    size: plaintext.length,
    paddedSize,
  };
}

export async function decryptObject(
  chunks: Uint8Array[],
  objectKey: Uint8Array,
  size: number,
): Promise<Uint8Array> {
  const padded = await openWith(joinChunks(chunks), objectIdentity(objectKey), "the object");
  if (size > padded.length) throw new Error("recorded size exceeds the decrypted object");
  return padded.subarray(0, size);
}
