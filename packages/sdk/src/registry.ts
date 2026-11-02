import { contentHashFromCid, signerFromSeed, toHex } from "@memdot/chain";
import { REGISTRY_ADDRESS } from "@memdot/config";
import {
  Action,
  actionHash,
  encodeRecord,
  memDotRegistryAbi,
  NO_SALT,
  ObjectKind,
  Scope,
  SpaceMode,
  signingMessage,
  uuidToBytes32,
} from "@memdot/contracts";
import { ownerSeed, publicKeyFromAgeRecipient } from "@memdot/crypto";
import { encodeFunctionData, type Hex, hexToBytes } from "viem";
import type { Context } from "./context.js";
import { unwrap } from "./transport.js";

const NONCE_BYTES = 8;

/** A nonce only has to be unique for its owner; readers apply each (owner, nonce) pair once. */
function randomNonce(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  return bytes.reduce((value, byte) => (value << 8n) | BigInt(byte), 0n);
}

const hashOfCid = (cid: string): Hex => toHex(contentHashFromCid(cid)) as Hex;

const OBJECT_KIND: Record<string, number> = {
  file: ObjectKind.Manifest,
  manifest: ObjectKind.Manifest,
  segment: ObjectKind.Segment,
  index_snapshot: ObjectKind.IndexSnapshot,
  key_bundle: ObjectKind.KeyBundle,
  grant_key: ObjectKind.GrantKey,
};

const saltOf = (spaceId: string | null | undefined): Hex =>
  spaceId ? uuidToBytes32(spaceId) : NO_SALT;

/**
 * Keeps the public, owner-signed record of this account's data in MemDotRegistry on Portaldot V3.
 * Records are signed with the key derived from the master key, so they never prompt a wallet, and
 * the relayer submits them. They describe stored data rather than hold it: a record that fails
 * never fails the upload or share it describes.
 */
export class RegistryLog {
  constructor(private readonly ctx: Pick<Context, "transport" | "vault">) {}

  /** Publishes the sharing key once for accounts that have not, as the first record. */
  async ensureRegistered(): Promise<void> {
    if (!this.ctx.vault.unlocked) return;
    try {
      const { account } = await unwrap(this.ctx.transport.api.GET("/v1/account"));
      if (account && !account.registryOwner && account.keyBundleCid) {
        await this.registerKey(account.keyBundleCid);
      }
    } catch (error) {
      console.warn("[memdot] registry check skipped:", error);
    }
  }

  registerKey(keyBundleCid: string): Promise<void> {
    if (!this.ctx.vault.unlocked) return Promise.resolve();
    const encryptionKey = toHex(publicKeyFromAgeRecipient(this.ctx.vault.recipient())) as Hex;
    return this.record(
      NO_SALT,
      Action.RegisterKey,
      encodeRecord.registerKey(encryptionKey, hashOfCid(keyBundleCid)),
    );
  }

  /**
   * The account's last record, signed but not sent: it goes with the delete request, so a refused
   * delete leaves no record saying the account has gone.
   */
  deleteAccountCalldata(): Hex | null {
    if (!this.ctx.vault.unlocked) return null;
    return this.signedCall(NO_SALT, Action.DeleteAccount, encodeRecord.deleteAccount());
  }

  createSpace(spaceId: string, mode: "sponsored" | "self_signed"): Promise<void> {
    const onChainMode = mode === "self_signed" ? SpaceMode.SelfSigned : SpaceMode.Sponsored;
    return this.record(saltOf(spaceId), Action.CreateSpace, encodeRecord.createSpace(onChainMode));
  }

  deleteSpace(spaceId: string): Promise<void> {
    return this.record(saltOf(spaceId), Action.DeleteSpace, encodeRecord.deleteSpace());
  }

  /** Records an object by its root blob, which names the rest (a manifest lists its chunks). */
  addObject(input: { spaceId?: string; kind: string; rootCid: string; size: number }) {
    return this.record(
      saltOf(input.spaceId),
      Action.AddObjects,
      encodeRecord.addObjects(
        [hashOfCid(input.rootCid)],
        [OBJECT_KIND[input.kind] ?? ObjectKind.File],
        [BigInt(input.size)],
      ),
    );
  }

  /** Several objects in one record, for the cost of one. */
  addObjects(spaceId: string, items: { kind: string; rootCid: string; size: number }[]) {
    return this.record(
      saltOf(spaceId),
      Action.AddObjects,
      encodeRecord.addObjects(
        items.map((item) => hashOfCid(item.rootCid)),
        items.map((item) => OBJECT_KIND[item.kind] ?? ObjectKind.File),
        items.map((item) => BigInt(item.size)),
      ),
    );
  }

  tombstoneObject(spaceId: string | null | undefined, rootCid: string): Promise<void> {
    return this.record(
      saltOf(spaceId),
      Action.TombstoneObjects,
      encodeRecord.tombstoneObjects([hashOfCid(rootCid)]),
    );
  }

  grant(input: {
    grantId: string;
    spaceId: string;
    objectCid?: string | null;
    grantee: string;
    scope: "read" | "read_write";
    expiresAt?: string | null;
    wrappedKeyCid?: string | null;
  }): Promise<void> {
    const expiresAt = input.expiresAt ? Date.parse(input.expiresAt) / 1000 : 0;
    return this.record(
      saltOf(input.spaceId),
      Action.Grant,
      encodeRecord.grant(
        uuidToBytes32(input.grantId),
        input.objectCid ? hashOfCid(input.objectCid) : NO_SALT,
        /^0x[0-9a-fA-F]{64}$/.test(input.grantee) ? (input.grantee as Hex) : NO_SALT,
        input.scope === "read_write" ? Scope.ReadWrite : Scope.Read,
        BigInt(Math.floor(expiresAt)),
        input.wrappedKeyCid ? hashOfCid(input.wrappedKeyCid) : NO_SALT,
      ),
    );
  }

  revokeGrant(spaceId: string, grantId: string): Promise<void> {
    return this.record(
      saltOf(spaceId),
      Action.RevokeGrant,
      encodeRecord.revokeGrant(uuidToBytes32(grantId)),
    );
  }

  private signedCall(salt: Hex, action: number, data: Hex): Hex {
    const signer = signerFromSeed(ownerSeed(this.ctx.vault.amk()));
    const owner = toHex(signer.publicKey) as Hex;
    const nonce = randomNonce();
    const message = signingMessage(REGISTRY_ADDRESS, owner, nonce, actionHash(salt, action, data));
    const signature = signer.sign(hexToBytes(message));
    return encodeFunctionData({
      abi: memDotRegistryAbi,
      functionName: "record",
      args: [owner, salt, action, data, nonce, Array.from(signature) as never],
    });
  }

  private async record(salt: Hex, action: number, data: Hex): Promise<void> {
    if (!this.ctx.vault.unlocked) return;
    try {
      const calldata = this.signedCall(salt, action, data);
      await unwrap(this.ctx.transport.api.POST("/v1/registry/records", { body: { calldata } }));
    } catch (error) {
      console.warn("[memdot] registry record skipped:", error);
    }
  }
}
