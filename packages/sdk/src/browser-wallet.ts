import {
  type InjectedSigner,
  publicKeyOf,
  toBytes,
  toHex,
  txCreatorFromInjected,
} from "@memdot/chain";
import { VRF_OUTPUT_BYTES, VRF_WRAP_INPUT } from "@memdot/crypto";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { MemDotError } from "./errors.js";
import type { Wallet } from "./wallet.js";

/**
 * Browser wallets. Substrate extensions (Talisman, SubWallet, polkadot.js and anything else that
 * injects `window.injectedWeb3`) sign in with SIWS and, where they support `signVrf`, unlock the
 * key with a value bound to this site's origin. EVM wallets (MetaMask and others announced via
 * EIP-6963) sign in with SIWE.
 */

export const DAPP_NAME = "MemDot";

/** The Substrate wallets named in the UI, with where to get them. */
export const SUBSTRATE_WALLETS = [
  {
    id: "portaldot extension",
    name: "Portaldot Extension",
    url: "https://github.com/portaldotVolunteer",
  },
  { id: "talisman", name: "Talisman", url: "https://talisman.xyz/download" },
  { id: "subwallet-js", name: "SubWallet", url: "https://www.subwallet.app/download.html" },
  { id: "polkadot-js", name: "polkadot{.js}", url: "https://polkadot.js.org/extension/" },
] as const;

export interface InjectedAccount {
  address: string;
  name?: string;
  type?: string;
}

interface VrfPayload {
  address: string;
  data: string;
  context?: string;
}

interface Injected {
  accounts: { get(anyType?: boolean): Promise<InjectedAccount[]> };
  signer: InjectedSigner & {
    signRaw: (payload: {
      address: string;
      data: string;
      type: "bytes";
    }) => Promise<{ signature: string }>;
    signVrf?: (payload: VrfPayload) => Promise<{ signature: string }>;
  };
}

type InjectedWeb3 = Record<string, { enable(dappName: string): Promise<Injected> }>;

const injectedWeb3 = (): InjectedWeb3 =>
  (globalThis as { injectedWeb3?: InjectedWeb3 }).injectedWeb3 ?? {};

/** A Substrate account in a browser extension. */
export interface BrowserWallet extends Wallet {
  /** The extension id (`talisman`, `subwallet-js`, ...). */
  source: string;
  name?: string;
  /**
   * The 32-byte unlock secret from `signVrf`, or null when this wallet or account cannot make
   * one (polkadot.js, hardware and watch-only accounts). One approval prompt per call.
   */
  vrfSecret(): Promise<Uint8Array | null>;
}

/** Ids of the Substrate extensions present on this page. */
export function installedWallets(): string[] {
  return Object.keys(injectedWeb3());
}

/** Asks the extension for access and returns its sr25519/ed25519 accounts. */
export async function connectWallet(
  source: string,
): Promise<{ accounts: InjectedAccount[]; wallet: (address: string) => BrowserWallet }> {
  const extension = injectedWeb3()[source];
  if (!extension) {
    throw new MemDotError(404, "WALLET_NOT_INSTALLED", `${source} is not installed.`);
  }
  const injected = await extension.enable(DAPP_NAME).catch((error: unknown) => {
    throw new MemDotError(403, "WALLET_REJECTED", "The wallet did not allow access.", null, error);
  });
  const accounts = (await injected.accounts.get()).filter(
    (a) => !a.type || a.type === "sr25519" || a.type === "ed25519",
  );
  return {
    accounts,
    wallet: (address) => {
      const account = accounts.find((a) => a.address === address);
      if (!account) throw new MemDotError(404, "WALLET_ACCOUNT", "That account is not shared.");
      const type = account.type === "ed25519" ? "ed25519" : "sr25519";
      return {
        source,
        address,
        name: account.name,
        publicKey: publicKeyOf(address),
        txCreator: txCreatorFromInjected(address, injected.signer, type),
        async signMessage(message) {
          const { signature } = await injected.signer
            .signRaw({ address, data: toHex(utf8ToBytes(message)), type: "bytes" })
            .catch(rejected);
          return toBytes(signature);
        },
        async vrfSecret() {
          if (typeof injected.signer.signVrf !== "function" || type !== "sr25519") return null;
          const { signature } = await injected.signer
            .signVrf({
              address,
              data: toHex(utf8ToBytes(VRF_WRAP_INPUT.data)),
              context: toHex(utf8ToBytes(VRF_WRAP_INPUT.context)),
            })
            .catch(rejected);
          return toBytes(signature).slice(0, VRF_OUTPUT_BYTES);
        },
      };
    },
  };
}

function rejected(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (/cancel|reject|denied/i.test(message)) {
    throw new MemDotError(
      400,
      "WALLET_CANCELLED",
      "The wallet request was cancelled.",
      null,
      error,
    );
  }
  throw new MemDotError(400, "WALLET_ERROR", message, null, error);
}

// ── EVM wallets ─────────────────────────────────────────────────────────────────────────────

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export interface EvmWalletInfo {
  uuid: string;
  name: string;
  /** Data URI of the wallet's icon, as announced. */
  icon: string;
  rdns: string;
  provider: Eip1193Provider;
}

/** An EVM account that can sign EIP-191 messages (SIWE sign-in and the owner proof). */
export interface EvmWallet {
  address: `0x${string}`;
  signMessage(message: string): Promise<`0x${string}`>;
}

const ANNOUNCE_WAIT_MS = 150;

/** EVM wallets that announce themselves (EIP-6963); MetaMask answers as `io.metamask`. */
export function discoverEvmWallets(): Promise<EvmWalletInfo[]> {
  if (typeof window === "undefined") return Promise.resolve([]);
  const found = new Map<string, EvmWalletInfo>();
  const onAnnounce = (event: Event) => {
    const { info, provider } = (
      event as CustomEvent<{ info: Omit<EvmWalletInfo, "provider">; provider: Eip1193Provider }>
    ).detail;
    found.set(info.uuid, { ...info, provider });
  };
  window.addEventListener("eip6963:announceProvider", onAnnounce);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  return new Promise((resolve) =>
    setTimeout(() => {
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
      resolve([...found.values()]);
    }, ANNOUNCE_WAIT_MS),
  );
}

export async function connectEvmWallet(info: EvmWalletInfo): Promise<EvmWallet> {
  const [address] = (await info.provider
    .request({ method: "eth_requestAccounts" })
    .catch(rejected)) as `0x${string}`[];
  if (!address) throw new MemDotError(403, "WALLET_REJECTED", "The wallet shared no account.");
  return {
    address,
    signMessage: async (message) =>
      (await info.provider
        .request({ method: "personal_sign", params: [toHex(utf8ToBytes(message)), address] })
        .catch(rejected)) as `0x${string}`,
  };
}
