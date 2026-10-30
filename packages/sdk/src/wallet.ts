import { signerFromMnemonic, type TxCreator } from "@memdot/chain";
import { utf8ToBytes } from "@noble/hashes/utils.js";

/**
 * A Substrate account that can sign: a local key in Node and scripts, a wallet extension in the
 * browser. It signs in (SIWS), proves it owns the chain account, and in self-signed spaces signs
 * each top-level `store` itself.
 */
export interface Wallet {
  /** SS58 address. */
  address: string;
  /** AccountId32 (the sr25519 public key). */
  publicKey: Uint8Array;
  /** Signs a message the way wallet extensions sign raw payloads: wrapped in `<Bytes>…</Bytes>`. */
  signMessage(message: string): Promise<Uint8Array>;
  /** Signs extrinsics; needed only for self-signed spaces. */
  txCreator?: TxCreator;
}

/** A wallet from a mnemonic (sr25519, the derivation polkadot.js and Talisman use). */
export function walletFromMnemonic(mnemonic: string, derivationPath = ""): Wallet {
  const signer = signerFromMnemonic(mnemonic, derivationPath);
  return {
    address: signer.address,
    publicKey: signer.publicKey,
    txCreator: signer.txCreator,
    signMessage: async (message) => signer.sign(utf8ToBytes(`<Bytes>${message}</Bytes>`)),
  };
}
