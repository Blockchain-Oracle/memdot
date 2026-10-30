import { ageIdentity, ageRecipient, deriveKey, INFO, randomKey, x25519FromSeed } from "./keys.js";

/**
 * A space (or folder) key is symmetric; its X25519 identity is derived from it, so anything
 * sealed to the space recipient opens for whoever holds the key. Revoking access rotates the key
 * to a new epoch: new writes use the new key, old ciphertext stays readable to past holders.
 */
export interface SpaceKey {
  epoch: number;
  key: Uint8Array;
}

/**
 * The owner's space keys are derived, not stored: the master key, the space id and the epoch give
 * the same key on any device, so nothing extra is written to the chain or the database. Revoking
 * a grant moves the space to the next epoch, whose key no former grantee was ever given.
 */
export function deriveSpaceKey(
  accountMasterKey: Uint8Array,
  spaceId: string,
  epoch: number,
): SpaceKey {
  return { epoch, key: deriveKey(accountMasterKey, `${INFO.spaceKey}/${spaceId}/${epoch}`) };
}

/** Every epoch's key up to and including `throughEpoch`: what a space grant hands over. */
export function deriveSpaceKeys(
  accountMasterKey: Uint8Array,
  spaceId: string,
  throughEpoch: number,
): SpaceKey[] {
  return Array.from({ length: throughEpoch + 1 }, (_, epoch) =>
    deriveSpaceKey(accountMasterKey, spaceId, epoch),
  );
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
