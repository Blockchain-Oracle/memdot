export { formatTpot } from "@memdot/chain";
export { isValidRecoveryCode, normalizeRecoveryCode } from "@memdot/crypto";
export {
  type Account,
  AccountApi,
  type Me,
  type Owner,
  type Passkey,
  type PasskeySignIn,
  type SetupOptions,
  type SignInOptions,
  type UnlockWrap,
} from "./account.js";
export { ActivityApi, type ChainTransaction, type RequestLogEntry } from "./activity.js";
export {
  type Agent,
  AgentsApi,
  type ApproveConnect,
  type ConnectRequest,
  type ConnectResult,
  type ConnectStart,
  newAgentIdentity,
} from "./agents.js";
export {
  type BrowserWallet,
  connectEvmWallet,
  connectWallet,
  DAPP_NAME,
  discoverEvmWallets,
  type EvmWallet,
  type EvmWalletInfo,
  type InjectedAccount,
  installedWallets,
  SUBSTRATE_WALLETS,
} from "./browser-wallet.js";
export type { Schemas } from "./context.js";
export {
  type ArchiveFile,
  DataApi,
  type ExportManifest,
  type ExportProgress,
  type ImportReport,
} from "./data.js";
export { LockedError, MemDotError } from "./errors.js";
export {
  type FileInfo,
  FilesApi,
  type ListedFile,
  type PutOptions,
  type PutResult,
  type VerifyResult,
} from "./files.js";
export { type Job, JobFailedError, JobsApi, type WaitOptions } from "./jobs.js";
export { type ApiKey, KeysApi, type NewApiKey } from "./keys.js";
export { localEmbedder } from "./local-embedder.js";
export { MemDot, type MemDotOptions, type Usage } from "./memdot.js";
export {
  type AddOptions,
  type AddResult,
  type Entity,
  type HistoryEvent,
  type ListOptions,
  MemoriesApi,
  type Memory,
  type MemoryEvent,
  type MemoryMode,
  type MemoryScope,
  type MemoryUpdate,
  type Namespace,
  type ScoredMemory,
  type SearchOptions,
} from "./memories.js";
export { passkeysSupported } from "./passkey.js";
export {
  type CidProof,
  ProofApi,
  type ProofRecent,
  type ProofStats,
  type TxProof,
} from "./proof.js";
export type { components, paths } from "./schema.js";
export {
  type Grant,
  type Recipient,
  type SharedDetails,
  type SharedSpace,
  type ShareOptions,
  type ShareTarget,
  SharingApi,
} from "./sharing.js";
export { type Folder, FoldersApi, type Space, SpacesApi } from "./spaces.js";
export type { ReceivedKeys } from "./vault.js";
export { type Wallet, walletFromMnemonic } from "./wallet.js";
