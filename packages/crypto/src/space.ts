import { ageIdentity, ageRecipient, INFO, randomKey, x25519FromSeed } from "./keys.js";

/**
 * A space (or folder) key is symmetric; its X25519 identity is derived from it, so anything
 * sealed to the space recipient opens for whoever holds the key. Revoking access rotates the key
 * to a new epoch: new writes use the new key, old ciphertext stays readable to past holders.
 */
export interface SpaceKey {
  epoch: number;
  key: Uint8Array;
}

export function generateSpaceKey(epoch = 0): SpaceKey {
  return { epoch, key: randomKey() };
}

export function rotateSpaceKey(current: SpaceKey): SpaceKey {
  return generateSpaceKey(current.epoch + 1);
}

function spaceKeyPair(spaceKey: SpaceKey) {
  return x25519FromSeed(spaceKey.key, `${INFO.space}/${spaceKey.epoch}`);
}

export function spaceRecipient(spaceKey: SpaceKey): string {
  return ageRecipient(spaceKeyPair(spaceKey).publicKey);
}

export function spaceIdentity(spaceKey: SpaceKey): string {
  return ageIdentity(spaceKeyPair(spaceKey).secretKey);
}
