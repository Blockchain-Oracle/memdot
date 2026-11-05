import type { ChainClient } from "@memdot/chain";
import { PORTALDOT_WSS } from "@memdot/config";
import type { Embedder } from "@memdot/memory-engine";
import { AccountApi } from "./account.js";
import { ActivityApi } from "./activity.js";
import { AgentsApi } from "./agents.js";
import type { Context, Schemas } from "./context.js";
import { DataApi } from "./data.js";
import { MemDotError } from "./errors.js";
import { FilesApi } from "./files.js";
import { JobsApi } from "./jobs.js";
import { KeysApi } from "./keys.js";
import { MemoriesApi } from "./memories.js";
import { ProofApi } from "./proof.js";
import { RegistryLog } from "./registry.js";
import { SharingApi } from "./sharing.js";
import { FoldersApi, SpacesApi } from "./spaces.js";
import { Transport, type TransportOptions, unwrap } from "./transport.js";
import { Vault } from "./vault.js";
import { WebhooksApi } from "./webhooks.js";

export type Usage = Schemas["Usage"];

export interface MemDotOptions extends TransportOptions {
  /** Portaldot V3 node for verify and self-signed writes (default: the public testnet node). */
  rpc?: string;
  /** Wrap keys for waiting grants after every unlock (default true). */
  completeGrantsOnUnlock?: boolean;
  /**
   * What Private namespaces embed with. Default: a local model, in this thread, downloaded once.
   * In a browser, pass a Worker-backed one so typing never waits on it.
   */
  embedder?: Embedder;
  /** Where memories go when a call doesn't name a namespace. Default: the API picks your first Assisted one. */
  namespaceId?: string;
}

/**
 * The MemDot client. Encryption happens here, on your device: the API only ever receives
 * ciphertext, sealed names and CIDs.
 *
 * ```ts
 * const memdot = MemDot.create({ baseUrl: "https://api.memdot.xyz", apiKey: process.env.MEMDOT_API_KEY });
 * await memdot.account.unlockWithRecoveryCode(process.env.MEMDOT_RECOVERY_CODE!);
 * const space = await memdot.spaces.create({ name: "Uploads" });
 * const { file } = await memdot.files.put(bytes, { spaceId: space.id, name: "photo.jpg" });
 * ```
 */
export class MemDot {
  readonly account: AccountApi;
  readonly spaces: SpacesApi;
  readonly folders: FoldersApi;
  readonly files: FilesApi;
  readonly sharing: SharingApi;
  readonly jobs: JobsApi;
  readonly keys: KeysApi;
  readonly activity: ActivityApi;
  readonly proof: ProofApi;
  readonly memories: MemoriesApi;
  readonly data: DataApi;
  readonly agents: AgentsApi;
  readonly webhooks: WebhooksApi;

  private readonly transport: Transport;
  private readonly registry: RegistryLog;
  private readonly vault: Vault;
  private chainClient: Promise<ChainClient> | null = null;

  private constructor(private readonly options: MemDotOptions) {
    this.transport = new Transport(options);
    const vault = new Vault();
    this.vault = vault;
    this.registry = new RegistryLog({ transport: this.transport, vault });
    const ctx: Context = {
      transport: this.transport,
      vault,
      registry: this.registry,
      ensureKeys: (spaceId, epoch) => this.sharing.ensureKeys(spaceId, epoch),
      chain: () => this.chain(),
    };
    this.jobs = new JobsApi(ctx);
    this.keys = new KeysApi(ctx);
    this.activity = new ActivityApi(ctx);
    this.proof = new ProofApi(ctx);
    this.spaces = new SpacesApi(ctx);
    this.folders = new FoldersApi(ctx, this.spaces);
    this.files = new FilesApi(ctx, this.spaces, this.jobs);
    this.sharing = new SharingApi(ctx, this.spaces);
    this.memories = new MemoriesApi(
      ctx,
      this.spaces,
      this.folders,
      this.jobs,
      options.embedder,
      options.namespaceId,
    );
    this.data = new DataApi(ctx, this.spaces, this.folders, this.files, this.memories);
    this.agents = new AgentsApi(ctx, this.sharing);
    this.webhooks = new WebhooksApi(ctx);
    this.account = new AccountApi(ctx, options.origin, () => this.afterUnlock());
  }

  static create(options: MemDotOptions): MemDot {
    return new MemDot(options);
  }

  /** Switch to (or drop) an API key, for example after minting one in a script. */
  setApiKey(apiKey: string | undefined): void {
    this.transport.apiKey = apiKey;
  }

  /**
   * Runs as a connected agent: this API key, and the device's own identity to open what was shared
   * with it. `memdot login` makes both. Only what the owner chose can be read or written.
   */
  connectAgent(input: { apiKey: string; identity: string }): void {
    this.transport.apiKey = input.apiKey;
    this.vault.connectAgentIdentity(input.identity);
  }

  usage(): Promise<Usage> {
    return unwrap(this.transport.api.GET("/v1/usage"));
  }

  /**
   * This device's own connection to Portaldot V3, opened on first use: verify reads through it,
   * and a UI can follow `client.finalizedBlock$` for the live head. Never routed through MemDot.
   */
  chain(): Promise<ChainClient> {
    this.chainClient ??= import("@memdot/chain")
      .then(({ createChainClient }) => createChainClient(this.options.rpc ?? PORTALDOT_WSS))
      .catch((error) => {
        this.chainClient = null;
        throw error;
      });
    return this.chainClient;
  }

  /** Closes the chain connection, if one was opened. Keys stay until `account.lock()`. */
  async close(): Promise<void> {
    const opening = this.chainClient;
    this.chainClient = null;
    // One that never connected has nothing to close.
    const chain = await opening?.catch(() => null);
    chain?.destroy();
  }

  private async afterUnlock(): Promise<void> {
    await this.registry.ensureRegistered();
    // Records what the server stored while this device was away; never in the way of an unlock.
    void this.memories.recordServerSegments().catch((error: unknown) => {
      console.warn("[memdot] recording memory segments skipped:", error);
    });
    if (this.options.completeGrantsOnUnlock === false) return;
    try {
      await this.sharing.completeReady();
    } catch (error) {
      // A key without sharing rights, or an account still being set up, simply has nothing to do.
      if (!(error instanceof MemDotError) || ![403, 409].includes(error.status)) throw error;
    }
  }
}
