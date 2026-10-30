import {
  deriveSpaceKey,
  type FileManifest,
  type SpaceKey,
  spaceIdentity,
  spaceRecipient,
  userIdentity,
  userRecipient,
} from "@memdot/crypto";
import { LockedError } from "./errors.js";

/** What a received grant opened: a space's keys, or one file's manifest. */
export type ReceivedKeys =
  | { kind: "space"; spaceId: string; keys: SpaceKey[] }
  | { kind: "file"; manifest: FileManifest };

/**
 * Keys held in memory while the account is unlocked: the master key, and what received grants
 * opened. Nothing here is ever sent to the API. Locking forgets all of it.
 */
export class Vault {
  private masterKey: Uint8Array | null = null;
  private readonly received = new Map<string, ReceivedKeys>();

  get unlocked(): boolean {
    return this.masterKey !== null;
  }

  unlock(masterKey: Uint8Array): void {
    this.lock();
    this.masterKey = Uint8Array.from(masterKey);
  }

  lock(): void {
    this.masterKey?.fill(0);
    this.masterKey = null;
    this.received.clear();
  }

  amk(what?: string): Uint8Array {
    if (!this.masterKey) throw new LockedError(what);
    return this.masterKey;
  }

  /** This account's sharing identity (opens what others shared with it). */
  identity(): string {
    return userIdentity(this.amk("that"));
  }

  recipient(): string {
    return userRecipient(this.amk("that"));
  }

  /** The owner's key for one epoch of a space. */
  spaceKey(spaceId: string, epoch: number): SpaceKey {
    return deriveSpaceKey(this.amk("that"), spaceId, epoch);
  }

  sealTo(spaceId: string, epoch: number): string {
    return spaceRecipient(this.spaceKey(spaceId, epoch));
  }

  /** Identities for every epoch so far, newest first, for anything sealed in this space. */
  ownedIdentities(spaceId: string, throughEpoch: number): string[] {
    const identities: string[] = [];
    for (let epoch = throughEpoch; epoch >= 0; epoch -= 1) {
      identities.push(spaceIdentity(this.spaceKey(spaceId, epoch)));
    }
    return identities;
  }

  rememberReceived(grantId: string, keys: ReceivedKeys): void {
    this.received.set(grantId, keys);
  }

  receivedKeys(grantId: string): ReceivedKeys | undefined {
    return this.received.get(grantId);
  }
}

/** Identities from a received keyring, newest epoch first. */
export function keyringIdentities(keys: SpaceKey[]): string[] {
  return [...keys].sort((a, b) => b.epoch - a.epoch).map((key) => spaceIdentity(key));
}
