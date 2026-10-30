import { signerFromSeed, toHex } from "@memdot/chain";
import { EVM_ACCOUNT_SUFFIX, EVM_CHAIN_ID } from "@memdot/config";
import {
  addWrap,
  createKeyBundle,
  generateRecoveryCode,
  type KeyBundle,
  type KeyWrap,
  ownerSeed,
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
import { createSiweMessage } from "viem/siwe";
import type { BrowserWallet, EvmWallet } from "./browser-wallet.js";
import type { Context, Schemas } from "./context.js";
import { MemDotError } from "./errors.js";
import { createPasskey, evaluatePasskey, getPasskey } from "./passkey.js";
import { storeObject } from "./store.js";
import { unwrap } from "./transport.js";
import type { Wallet } from "./wallet.js";

export type Me = Schemas["Me"];
export type Account = Schemas["Account"];

/** Mirrors the API's owner proof: the wallet signs a message bound to the user id. */
const ownerProofMessage = (userId: string, ownerAccount: string) =>
  `memdot:owner:v1:${userId}:${ownerAccount}`;

const RECOVERY_WRAP = { kind: "recovery" as const, id: "recovery" };
const PASSKEY_AUTH = "/api/auth/passkey";

/** A way to unlock that `setUp` or `add*` wraps the master key to (besides the recovery code). */
export interface UnlockWrap {
  kind: "passkey" | "vrf";
  /** Passkey credential id, or the wallet address. */
  id: string;
  secret: Uint8Array;
}

/** The chain account that owns the MemDot account; without one, a key derived from the master key. */
export type Owner = { kind: "substrate"; wallet: Wallet } | { kind: "evm"; wallet: EvmWallet };

export interface SetupOptions {
  owner?: Owner;
  unlock?: UnlockWrap[];
}

/** Outcome of a passkey ceremony, for the UI. `prf` is false when the passkey cannot unlock. */
export interface PasskeySignIn {
  userId: string;
  credentialId: string;
  prf: boolean;
  /** True when this sign-in also unlocked the key (an existing account and a PRF passkey). */
  unlocked: boolean;
}

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

  /** Calls the listener when this device locks or unlocks (for UIs); returns the unsubscribe. */
  onLockChange(listener: () => void): () => void {
    return this.ctx.vault.subscribe(listener);
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

  /** Sign-In with Ethereum (MetaMask and other EVM wallets). */
  async signInWithEvm(wallet: EvmWallet, options: SignInOptions = {}): Promise<{ userId: string }> {
    const origin = new URL(options.origin ?? this.defaultOrigin ?? requireOrigin());
    const { nonce } = await this.ctx.transport.json<{ nonce: string }>(
      "POST",
      "/api/auth/siwe/nonce",
      {},
    );
    const message = createSiweMessage({
      domain: origin.host,
      uri: origin.origin,
      address: wallet.address,
      chainId: EVM_CHAIN_ID,
      nonce,
      version: "1",
      statement: "Sign in to MemDot",
      issuedAt: new Date(),
    });
    const signature = await wallet.signMessage(message);
    const result = await this.ctx.transport.json<{ user: { id: string } }>(
      "POST",
      "/api/auth/siwe/verify",
      { message, signature },
    );
    return { userId: result.user.id };
  }

  /**
   * Creates the sign-in for a new account with a passkey (browser only). The passkey's PRF output
   * comes back for `setUp` to wrap the master key to; it never leaves this device.
   */
  async signUpWithPasskey(
    options: { name?: string } = {},
  ): Promise<{ userId: string; unlock: UnlockWrap | null }> {
    const query = new URLSearchParams(
      options.name ? { name: options.name, context: options.name } : {},
    );
    const creation = await this.ctx.transport.json<Parameters<typeof createPasskey>[0]>(
      "GET",
      `${PASSKEY_AUTH}/generate-register-options?${query}`,
    );
    const passkey = await createPasskey(creation);
    const result = await this.ctx.transport.json<{ user?: { id: string } }>(
      "POST",
      `${PASSKEY_AUTH}/verify-registration`,
      { response: passkey.response, createSession: true },
    );
    if (!result.user) throw new MemDotError(500, "PASSKEY_NO_SESSION", "No session was created.");
    return {
      userId: result.user.id,
      unlock: passkey.secret
        ? { kind: "passkey", id: passkey.credentialId, secret: passkey.secret }
        : null,
    };
  }

  /**
   * Signs in with any of this site's passkeys (browser only). One prompt: when the passkey has PRF
   * and the account is set up, the same prompt unlocks the key.
   */
  async signInWithPasskey(): Promise<PasskeySignIn> {
    const request = await this.ctx.transport.json<Parameters<typeof getPasskey>[0]>(
      "GET",
      `${PASSKEY_AUTH}/generate-authenticate-options`,
    );
    const passkey = await getPasskey(request);
    const result = await this.ctx.transport.json<{ user?: { id: string }; session?: unknown }>(
      "POST",
      `${PASSKEY_AUTH}/verify-authentication`,
      { response: passkey.response },
    );
    const userId = result.user?.id ?? (await this.me()).user.id;
    let unlocked = false;
    if (passkey.secret) {
      const { account } = await this.me();
      if (account?.keyBundleCid) {
        await this.unlockWith("passkey", passkey.secret, passkey.credentialId);
        unlocked = true;
      }
    }
    return { userId, credentialId: passkey.credentialId, prf: passkey.secret !== null, unlocked };
  }

  /**
   * Finishes a new account after any sign-in: master key, recovery code (shown once, the return
   * value), sharing key, owner proof, and the key bundle stored on chain, wrapped to the recovery
   * code and each `unlock` method. Without an owner wallet, the chain owner is a key derived from
   * the master key. Leaves the account unlocked.
   */
  async setUp(options: SetupOptions = {}): Promise<{ recoveryCode: string }> {
    const { user } = await this.me();
    const recoveryCode = generateRecoveryCode();
    const { accountMasterKey, bundle } = createKeyBundle();
    let next = addWrap(bundle, accountMasterKey, RECOVERY_WRAP, recoverySecret(recoveryCode));
    for (const wrap of options.unlock ?? []) {
      next = addWrap(next, accountMasterKey, { kind: wrap.kind, id: wrap.id }, wrap.secret);
    }

    await this.ctx.transport.json("POST", "/api/auth/recovery/register", {
      publicKey: toHex(recoverySignInKey(recoveryCode).publicKey),
    });
    await unwrap(
      this.ctx.transport.api.PUT("/v1/account", {
        body: {
          owner: await ownerProof(user.id, accountMasterKey, options.owner),
          encryptionKey: userRecipient(accountMasterKey),
        },
      }),
    );
    await this.storeBundle(next);
    this.ctx.vault.unlock(accountMasterKey);
    await this.onUnlock();
    return { recoveryCode };
  }

  /**
   * Creates a MemDot account for a Substrate wallet: signs in, then `setUp` with the wallet as
   * owner (and its `signVrf` unlock when a browser wallet offers one).
   */
  async create(wallet: Wallet, options: SignInOptions = {}): Promise<{ recoveryCode: string }> {
    await this.signInWithWallet(wallet, options);
    const vrf = await (wallet as Partial<BrowserWallet>).vrfSecret?.();
    return this.setUp({
      owner: { kind: "substrate", wallet },
      unlock: vrf ? [{ kind: "vrf", id: wallet.address, secret: vrf }] : [],
    });
  }

  /**
   * Reads the PRF output of one of this site's passkeys, to wrap the key to it (one prompt, local
   * only). Null when the passkey has no PRF.
   */
  async passkeyUnlockWrap(): Promise<UnlockWrap | null> {
    const passkey = await evaluatePasskey({ allowCredentials: [] });
    return passkey.secret
      ? { kind: "passkey", id: passkey.credentialId, secret: passkey.secret }
      : null;
  }

  /** How this account can be unlocked: the key bundle's wraps (no secrets in them). */
  async unlockMethods(): Promise<Pick<KeyWrap, "kind" | "id">[]> {
    return (await this.keyBundle()).wraps.map(({ kind, id }) => ({ kind, id }));
  }

  /** Unlocks with one of the account's passkeys (one prompt, nothing sent to the server). */
  async unlockWithPasskey(): Promise<void> {
    const ids = (await this.unlockMethods()).filter((w) => w.kind === "passkey").map((w) => w.id);
    if (ids.length === 0) {
      throw new MemDotError(409, "NO_PASSKEY_UNLOCK", "No passkey can unlock this account yet.");
    }
    const passkey = await evaluatePasskey({
      allowCredentials: ids.map((id) => ({ id, type: "public-key" as const })),
    });
    if (!passkey.secret) {
      throw new MemDotError(422, "PRF_UNSUPPORTED", "This passkey cannot unlock on this device.");
    }
    await this.unlockWith("passkey", passkey.secret, passkey.credentialId);
  }

  /** Unlocks with a wallet's `signVrf` (Talisman, SubWallet; local sr25519 accounts). */
  async unlockWithWallet(wallet: BrowserWallet): Promise<void> {
    const secret = await wallet.vrfSecret();
    if (!secret) {
      throw new MemDotError(422, "VRF_UNSUPPORTED", "This wallet account cannot unlock MemDot.");
    }
    await this.unlockWith("vrf", secret, wallet.address);
  }

  /**
   * Adds a passkey to this account: it can sign in, and with PRF it also unlocks (its wrap is added
   * to the key bundle). Needs the account unlocked and a recent sign-in.
   */
  async addPasskey(name?: string): Promise<{ prf: boolean }> {
    const amk = this.ctx.vault.amk("adding a passkey");
    const query = new URLSearchParams(name ? { name } : {});
    const creation = await this.ctx.transport.json<Parameters<typeof createPasskey>[0]>(
      "GET",
      `${PASSKEY_AUTH}/generate-register-options?${query}`,
    );
    const passkey = await createPasskey(creation);
    await this.ctx.transport.json("POST", `${PASSKEY_AUTH}/verify-registration`, {
      response: passkey.response,
      ...(name ? { name } : {}),
    });
    if (!passkey.secret) return { prf: false };
    await this.storeBundle(
      addWrap(
        await this.keyBundle(),
        amk,
        { kind: "passkey", id: passkey.credentialId },
        passkey.secret,
      ),
    );
    return { prf: true };
  }

  /** Lets a wallet account unlock this account through `signVrf` (adds its wrap). */
  async addWalletUnlock(wallet: BrowserWallet): Promise<void> {
    const amk = this.ctx.vault.amk("adding a wallet unlock");
    const secret = await wallet.vrfSecret();
    if (!secret) {
      throw new MemDotError(422, "VRF_UNSUPPORTED", "This wallet account cannot unlock MemDot.");
    }
    await this.storeBundle(
      addWrap(await this.keyBundle(), amk, { kind: "vrf", id: wallet.address }, secret),
    );
  }

  /** Ends the session and forgets the keys on this device. */
  async signOut(): Promise<void> {
    this.lock();
    await this.ctx.transport.json("POST", "/api/auth/sign-out", {});
  }

  /** Opens the key bundle with the recovery code and keeps the master key on this device. */
  async unlockWithRecoveryCode(code: string): Promise<void> {
    await this.unlockWith("recovery", recoverySecret(code));
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

  private async unlockWith(kind: KeyWrap["kind"], secret: Uint8Array, id?: string): Promise<void> {
    const bundle = await this.keyBundle();
    this.ctx.vault.unlock(unwrapMasterKey(bundle, kind, secret, id));
    await this.onUnlock();
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

type OwnerBody = Schemas["AccountSetup"]["owner"];

/** Signs the owner proof with the owner wallet, or with the key derived from the master key. */
async function ownerProof(
  userId: string,
  accountMasterKey: Uint8Array,
  owner?: Owner,
): Promise<OwnerBody> {
  if (owner?.kind === "evm") {
    const address = owner.wallet.address.toLowerCase() as `0x${string}`;
    const signature = await owner.wallet.signMessage(
      ownerProofMessage(userId, `${address}${EVM_ACCOUNT_SUFFIX}`),
    );
    return { kind: "evm", address, signature };
  }
  if (owner?.kind === "substrate") {
    const account = toHex(owner.wallet.publicKey);
    const signature = await owner.wallet.signMessage(ownerProofMessage(userId, account));
    return { kind: "substrate", account, signature: toHex(signature) };
  }
  const derived = signerFromSeed(ownerSeed(accountMasterKey));
  const account = toHex(derived.publicKey);
  return {
    kind: "substrate",
    account,
    signature: toHex(derived.sign(utf8ToBytes(ownerProofMessage(userId, account)))),
  };
}

function requireOrigin(): never {
  throw new MemDotError(
    400,
    "ORIGIN_REQUIRED",
    "Pass `origin` (the dashboard URL the sign-in message names) when signing in from Node.",
  );
}
