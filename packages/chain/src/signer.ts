import { SS58_PREFIX } from "@memdot/config";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { entropyToMiniSecret, mnemonicToEntropy } from "@polkadot-labs/hdkd-helpers";
import { AccountId } from "polkadot-api";
import { getTxCreatorFromPjs } from "polkadot-api/pjs-signer";
import { getTxCreator } from "polkadot-api/tx-creator";

export type TxCreator = ReturnType<typeof getTxCreator>;

export interface LocalSigner {
  address: string;
  publicKey: Uint8Array;
  txCreator: TxCreator;
  /** Raw sr25519 signature over the bytes, for sign-in messages and owner proofs. */
  sign: (message: Uint8Array) => Uint8Array;
}

/**
 * sr25519 signer for the relayer, keeper and CLI. Uses the same mnemonic → mini-secret path as
 * polkadot.js wallets, so an empty derivation path gives the address those wallets show.
 */
export function signerFromMnemonic(mnemonic: string, derivationPath = ""): LocalSigner {
  return signerFromSeed(entropyToMiniSecret(mnemonicToEntropy(mnemonic)), derivationPath);
}

/** sr25519 signer from a 32-byte mini secret (for example one derived from the master key). */
export function signerFromSeed(miniSecret: Uint8Array, derivationPath = ""): LocalSigner {
  const keyPair = sr25519CreateDerive(miniSecret)(derivationPath);
  return {
    address: AccountId(SS58_PREFIX).dec(keyPair.publicKey),
    publicKey: keyPair.publicKey,
    txCreator: getTxCreator(keyPair.publicKey, "Sr25519", keyPair.sign),
    sign: keyPair.sign,
  };
}

/** The AccountId32 behind an SS58 address. */
export function publicKeyOf(address: string): Uint8Array {
  return AccountId(SS58_PREFIX).enc(address);
}

/** The raw-signing half of an injected wallet's signer (`window.injectedWeb3[x].enable()`). */
export type InjectedSigner = {
  signPayload: Parameters<typeof getTxCreatorFromPjs>[1];
  signRaw: Parameters<typeof getTxCreatorFromPjs>[2];
};

/** Signs extrinsics through a browser wallet extension (Talisman, SubWallet, polkadot.js). */
export function txCreatorFromInjected(
  address: string,
  signer: InjectedSigner,
  type: "sr25519" | "ed25519" = "sr25519",
): TxCreator {
  return getTxCreatorFromPjs(address, signer.signPayload, signer.signRaw, type) as TxCreator;
}

/** The SS58 address (prefix 42) of an AccountId32, given as bytes or hex. */
export function addressOf(accountId: Uint8Array | string): string {
  const bytes =
    typeof accountId === "string"
      ? Uint8Array.from(accountId.replace(/^0x/, "").match(/../g) ?? [], (h) =>
          Number.parseInt(h, 16),
        )
      : accountId;
  return AccountId(SS58_PREFIX).dec(bytes);
}
