import type { ChainClient } from "@memdot/chain";
import { PORTALDOT_WSS } from "@memdot/config";
import { AccountApi } from "./account.js";
import type { Context, Schemas } from "./context.js";
import { MemDotError } from "./errors.js";
import { FilesApi } from "./files.js";
import { JobsApi } from "./jobs.js";
import { KeysApi } from "./keys.js";
import { SharingApi } from "./sharing.js";
import { FoldersApi, SpacesApi } from "./spaces.js";
import { Transport, type TransportOptions, unwrap } from "./transport.js";
import { Vault } from "./vault.js";

export type Usage = Schemas["Usage"];

export interface MemDotOptions extends TransportOptions {
  /** Portaldot V3 node for verify and self-signed writes (default: the public testnet node). */
  rpc?: string;
  /** Wrap keys for waiting grants after every unlock (default true). */
  completeGrantsOnUnlock?: boolean;
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

  private readonly transport: Transport;
  private chainClient: Promise<ChainClient> | null = null;

  private constructor(private readonly options: MemDotOptions) {
    this.transport = new Transport(options);
    const vault = new Vault();
    const ctx: Context = {
      transport: this.transport,
      vault,
      chain: () => {
        this.chainClient ??= import("@memdot/chain").then(({ createChainClient }) =>
          createChainClient(options.rpc ?? PORTALDOT_WSS),
        );
        return this.chainClient;
      },
    };
    this.jobs = new JobsApi(ctx);
    this.keys = new KeysApi(ctx);
    this.spaces = new SpacesApi(ctx);
    this.folders = new FoldersApi(ctx, this.spaces);
    this.files = new FilesApi(ctx, this.spaces, this.jobs);
    this.sharing = new SharingApi(ctx, this.spaces);
    this.account = new AccountApi(ctx, options.origin, () => this.afterUnlock());
  }

  static create(options: MemDotOptions): MemDot {
    return new MemDot(options);
  }

  /** Switch to (or drop) an API key, for example after minting one in a script. */
  useApiKey(apiKey: string | undefined): void {
    this.transport.apiKey = apiKey;
  }

  usage(): Promise<Usage> {
    return unwrap(this.transport.api.GET("/v1/usage"));
  }

  /** Closes the chain connection, if one was opened. Keys stay until `account.lock()`. */
  async close(): Promise<void> {
    const chain = await this.chainClient;
    chain?.destroy();
    this.chainClient = null;
  }

  private async afterUnlock(): Promise<void> {
    if (this.options.completeGrantsOnUnlock === false) return;
    try {
      await this.sharing.completeReady();
    } catch (error) {
      // A key without sharing rights, or an account still being set up, simply has nothing to do.
      if (!(error instanceof MemDotError) || ![403, 409].includes(error.status)) throw error;
    }
  }
}
