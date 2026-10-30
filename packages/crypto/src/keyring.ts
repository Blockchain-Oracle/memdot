import { utf8ToBytes } from "@noble/hashes/utils.js";
import { base64 } from "@scure/base";
import { openWith, sealTo } from "./age.js";
import type { SpaceKey } from "./space.js";

/**
 * What a space grant delivers: the space's keys for every epoch so far, sealed to the grantee.
 * Old epochs open what was written before a rotation; the newest opens current writes. After a
 * revoke the owner's client re-seals a keyring with the new epoch for each grant still active.
 */
export interface SpaceKeyring {
  v: 1;
  kind: "space-keyring";
  spaceId: string;
  keys: { epoch: number; key: string }[];
}

export function sealSpaceKeyring(
  spaceId: string,
  keys: SpaceKey[],
  recipients: string[],
): Promise<Uint8Array> {
  const keyring: SpaceKeyring = {
    v: 1,
    kind: "space-keyring",
    spaceId,
    keys: keys.map((k) => ({ epoch: k.epoch, key: base64.encode(k.key) })),
  };
  return sealTo(utf8ToBytes(JSON.stringify(keyring)), recipients);
}

export async function openSpaceKeyring(
  ciphertext: Uint8Array,
  identity: string,
): Promise<{ spaceId: string; keys: SpaceKey[] }> {
  const keyring = JSON.parse(
    new TextDecoder().decode(await openWith(ciphertext, identity, "the space keyring")),
  ) as SpaceKeyring;
  if (keyring.v !== 1 || keyring.kind !== "space-keyring") throw new Error("unsupported keyring");
  return {
    spaceId: keyring.spaceId,
    keys: keyring.keys.map((k) => ({ epoch: k.epoch, key: base64.decode(k.key) })),
  };
}
