import { SS58_PREFIX } from "@memdot/config";
import { sr25519CreateDerive } from "@polkadot-labs/hdkd";
import { entropyToMiniSecret, mnemonicToEntropy } from "@polkadot-labs/hdkd-helpers";
import { AccountId } from "polkadot-api";
import { getTxCreator } from "polkadot-api/tx-creator";

export type TxCreator = ReturnType<typeof getTxCreator>;

export interface LocalSigner {
  address: string;
  publicKey: Uint8Array;
  txCreator: TxCreator;
}

/**
 * sr25519 signer for the relayer, keeper and CLI. Uses the same mnemonic → mini-secret path as
 * polkadot.js wallets, so an empty derivation path gives the address those wallets show.
 */
export function signerFromMnemonic(mnemonic: string, derivationPath = ""): LocalSigner {
  const keyPair = sr25519CreateDerive(entropyToMiniSecret(mnemonicToEntropy(mnemonic)))(
    derivationPath,
  );
  return {
    address: AccountId(SS58_PREFIX).dec(keyPair.publicKey),
    publicKey: keyPair.publicKey,
    txCreator: getTxCreator(keyPair.publicKey, "Sr25519", keyPair.sign),
  };
}
