import { toHex } from "@memdot/chain";
import {
  addWrap,
  createKeyBundle,
  generateRecoveryCode,
  type KeyBundle,
  parseKeyBundle,
  recoverySecret,
  recoverySignInKey,
  serializeKeyBundle,
  signRecoveryChallenge,
  unwrapMasterKey,
  userRecipient,
} from "@memdot/crypto";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { SiwsMessage } from "@talismn/siws";
import type { Context, Schemas } from "./context.js";
import { MemDotError } from "./errors.js";
import { storeObject } from "./store.js";
import { unwrap } from "./transport.js";
import type { Wallet } from "./wallet.js";

export type Me = Schemas["Me"];
export type Account = Schemas["Account"];

/** Mirrors the API's owner proof: the wallet signs a message bound to the user id. */
const ownerProofMessage = (userId: string, ownerAccount: string) =>
  `memdot:owner:v1:${userId}:${ownerAccount}`;

const RECOVERY_WRAP = { kind: "recovery" as const, id: "recovery" };

export interface SignInOptions {
  /** The dashboard origin the sign-in message names (defaults to the client's origin option). */
  origin?: string;
  /** Display name for a new account. */
  name?: string;
}

/**
 * Sign-in, setup and unlock. Signing in gives a session; unlocking gives this device the master
 * key (from the key bundle on chain), which never leaves it. Creating an account generates the
 * master key and the mandatory recovery code here, on the client.
 */
export class AccountApi {
  constructor(
    private readonly ctx: Context,
    private readonly defaultOrigin: string | undefined,
    private readonly onUnlock: () => Promise<void>,
  ) {}

  me(): Promise<Me> {
    return unwrap(this.ctx.transport.api.GET("/v1/account"));
  }

  get unlocked(): boolean {
    return this.ctx.vault.unlocked;
  }

  /** Sign-In with Substrate: the wallet signs a one-use message for this site. */
  async signInWithWallet(wallet: Wallet, options: SignInOptions = {}): Promise<{ userId: string }> {
    const origin = new URL(options.origin ?? this.defaultOrigin ?? requireOrigin());
    const { nonce } = await this.ctx.transport.json<{ nonce: string }>(
      "POST",
      "/api/auth/siws/nonce",
      {},
    );
    const message = new SiwsMessage({
      domain: origin.host,
      uri: origin.origin,
      address: wallet.address,
      nonce,
      statement: "Sign in to MemDot",
      chainName: "Portaldot",
      issuedAt: Date.now(),
    }).prepareMessage();
    const signature = await wallet.signMessage(message);
    const result = await this.ctx.transport.json<{ user: { id: string } }>(
      "POST",
      "/api/auth/siws/verify",
      { message, signature: toHex(signature), ...(options.name ? { name: options.name } : {}) },
    );
    return { userId: result.user.id };
  }

  /** Signs in with the recovery code alone (a new device with no passkey or wallet). */
  async signInWithRecoveryCode(code: string): Promise<{ userId: string }> {
    const key = recoverySignInKey(code);
    const { challenge } = await this.ctx.transport.json<{ challenge: string }>(
      "POST",
      "/api/auth/recovery/challenge",
      {},
    );
    const result = await this.ctx.transport.json<{ user: { id: string } }>(
      "POST",
      "/api/auth/recovery/verify",
      {
        publicKey: toHex(key.publicKey),
        challenge,
        signature: toHex(signRecoveryChallenge(code, utf8ToBytes(challenge))),
      },
    );
    return { userId: result.user.id };
  }

  /**
   * Creates a MemDot account for a wallet: master key, recovery code (shown once, return value),
   * sharing key, owner proof, and the key bundle stored on chain. Leaves the account unlocked.
   */
  async create(wallet: Wallet, options: SignInOptions = {}): Promise<{ recoveryCode: string }> {
    const { userId } = await this.signInWithWallet(wallet, options);
    const recoveryCode = generateRecoveryCode();
    const { accountMasterKey, bundle } = createKeyBundle();
    const withRecovery = addWrap(
      bundle,
      accountMasterKey,
      RECOVERY_WRAP,
      recoverySecret(recoveryCode),
    );

    await this.ctx.transport.json("POST", "/api/auth/recovery/register", {
      publicKey: toHex(recoverySignInKey(recoveryCode).publicKey),
    });
    const ownerAccount = toHex(wallet.publicKey);
    const proof = await wallet.signMessage(ownerProofMessage(userId, ownerAccount));
    await unwrap(
      this.ctx.transport.api.PUT("/v1/account", {
        body: {
          owner: { kind: "substrate", account: ownerAccount, signature: toHex(proof) },
          encryptionKey: userRecipient(accountMasterKey),
        },
      }),
    );
    await this.storeBundle(withRecovery);
    this.ctx.vault.unlock(accountMasterKey);
    await this.onUnlock();
    return { recoveryCode };
  }

  /** Opens the key bundle with the recovery code and keeps the master key on this device. */
  async unlockWithRecoveryCode(code: string): Promise<void> {
    const bundle = await this.keyBundle();
    this.ctx.vault.unlock(unwrapMasterKey(bundle, "recovery", recoverySecret(code)));
    await this.onUnlock();
  }

  /** For servers that hold the exported master key (keep it like any private key). */
  async unlockWithMasterKey(masterKey: Uint8Array): Promise<void> {
    this.ctx.vault.unlock(masterKey);
    await this.onUnlock();
  }

  /** Forgets every key on this device; the session stays signed in. */
  lock(): void {
    this.ctx.vault.lock();
  }

  /** A new device or a lost passkey: sign in with the code, then unlock with it. */
  async recover(code: string): Promise<void> {
    await this.signInWithRecoveryCode(code);
    await this.unlockWithRecoveryCode(code);
  }

  /**
   * Replaces the recovery code: the master key is re-wrapped with a new code, the new bundle is
   * stored, and the old code stops working (its sign-in key and its bundle are retired). Needs a
   * recent sign-in. The new code is shown once: the return value.
   */
  async regenerateRecoveryCode(): Promise<{ recoveryCode: string }> {
    const amk = this.ctx.vault.amk("a new recovery code");
    const recoveryCode = generateRecoveryCode();
    const bundle = addWrap(
      await this.keyBundle(),
      amk,
      RECOVERY_WRAP,
      recoverySecret(recoveryCode),
    );
    await this.ctx.transport.json("POST", "/api/auth/recovery/register", {
      publicKey: toHex(recoverySignInKey(recoveryCode).publicKey),
    });
    await this.storeBundle(bundle);
    return { recoveryCode };
  }

  private async keyBundle(): Promise<KeyBundle> {
    const { account } = await this.me();
    if (!account?.keyBundleCid) {
      throw new MemDotError(409, "ACCOUNT_SETUP_REQUIRED", "This account has no key bundle yet.");
    }
    return parseKeyBundle(await this.ctx.transport.bytes(`/v1/cids/${account.keyBundleCid}`));
  }

  /** Stores a key bundle as an account object and points the account at it. */
  private async storeBundle(bundle: KeyBundle): Promise<void> {
    const bytes = serializeKeyBundle(bundle);
    const declared = await storeObject(this.ctx, {
      kind: "key_bundle",
      sizeBytes: bytes.length,
      root: bytes,
    });
    await unwrap(
      this.ctx.transport.api.PATCH("/v1/account", {
        body: { keyBundleCid: declared.object.cid ?? "" },
      }),
    );
  }
}

function requireOrigin(): never {
  throw new MemDotError(
    400,
    "ORIGIN_REQUIRED",
    "Pass `origin` (the dashboard URL the sign-in message names) when signing in from Node.",
  );
}
