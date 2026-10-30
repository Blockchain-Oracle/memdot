import {
  deriveSpaceKeys,
  type FileManifest,
  openManifest,
  openSpaceKeyring,
  sealManifest,
  sealSpaceKeyring,
} from "@memdot/crypto";
import type { Context, Schemas } from "./context.js";
import { MemDotError } from "./errors.js";
import { type FileInfo, type ObjectDetail, openFileInfo, readObject } from "./files.js";
import { openText, type SpacesApi } from "./spaces.js";
import { storeObject } from "./store.js";
import { unwrap } from "./transport.js";
import { keyringIdentities, type ReceivedKeys } from "./vault.js";

export type Grant = Schemas["Grant"];
export type SharedSpace = Schemas["SharedSpace"];

/** A received grant, opened on this device: the space's (or file's) name in clear. */
export interface SharedDetails extends Omit<SharedSpace, "encryptedName"> {
  name: string | null;
}
export type Recipient = Schemas["Recipient"];

export type ShareTarget = { address: string } | { agentId: string; agentKey: string };

export interface ShareOptions {
  scope?: Grant["scope"];
  /** ISO time after which the grant stops working. */
  expiresAt?: string;
}

/**
 * Sharing, both sides. The owner wraps keys on this device: a space grant seals the space's
 * keyring (every epoch so far) to the recipient; a file grant re-seals that file's manifest. If
 * the recipient has no MemDot key yet the grant waits as pending, and completes the next time the
 * owner unlocks. Revoking moves the space to a new epoch the former grantee never receives.
 */
export class SharingApi {
  constructor(
    private readonly ctx: Context,
    private readonly spaces: SpacesApi,
  ) {}

  recipient(address: string): Promise<Recipient> {
    return unwrap(
      this.ctx.transport.api.GET("/v1/recipients/{address}", { params: { path: { address } } }),
    );
  }

  /** Shares a whole space: current files, and new ones until revoked. */
  async shareSpace(spaceId: string, to: ShareTarget, options: ShareOptions = {}): Promise<Grant> {
    const space = await this.spaces.raw(spaceId);
    const recipientKey = await this.recipientKey(to);
    if (!recipientKey) return this.create({ spaceId, to, options });
    const wrappedKeyCid = await this.storeGrantKey(
      await sealSpaceKeyring(
        spaceId,
        deriveSpaceKeys(this.ctx.vault.amk("sharing"), spaceId, space.keyEpoch),
        [recipientKey],
      ),
    );
    return this.create({ spaceId, to, options, wrappedKeyCid, keyEpoch: space.keyEpoch });
  }

  /** Shares one file: its manifest is re-sealed to the recipient; the chunks are untouched. */
  async shareFile(objectId: string, to: ShareTarget, options: ShareOptions = {}): Promise<Grant> {
    const detail = await this.detail(objectId);
    if (!detail.spaceId) throw new MemDotError(400, "NOT_A_FILE", "That object is not a file.");
    if (detail.segmentId) {
      throw new MemDotError(
        400,
        "TINY_FILE_SHARE",
        "Files under 64 KiB live inside a shared segment; share their space instead.",
      );
    }
    const recipientKey = await this.recipientKey(to);
    if (!recipientKey) return this.create({ spaceId: detail.spaceId, objectId, to, options });
    const manifest = await this.ownManifest(detail);
    const wrappedKeyCid = await this.storeGrantKey(await sealManifest(manifest, [recipientKey]));
    return this.create({ spaceId: detail.spaceId, objectId, to, options, wrappedKeyCid });
  }

  list(direction: "given" | "received" = "given", spaceId?: string) {
    return unwrap(
      this.ctx.transport.api.GET("/v1/grants", {
        params: { query: { direction, ...(spaceId ? { spaceId } : {}) } },
      }),
    );
  }

  /** Stops future access and moves the space to a new key epoch. */
  revoke(grantId: string) {
    return unwrap(
      this.ctx.transport.api.DELETE("/v1/grants/{id}", { params: { path: { id: grantId } } }),
    );
  }

  /**
   * Wraps keys for every grant that is waiting on this account: recipients who set up MemDot
   * since you shared, and active space grants a revoke left one epoch behind. The SDK calls this
   * after each unlock. Returns how many grants it completed.
   */
  async completeReady(): Promise<number> {
    const { items } = await unwrap(this.ctx.transport.api.GET("/v1/grants/ready"));
    for (const { grant, recipientKey } of items) {
      if (grant.objectId) {
        const manifest = await this.ownManifest(await this.detail(grant.objectId));
        const wrappedKeyCid = await this.storeGrantKey(
          await sealManifest(manifest, [recipientKey]),
        );
        await this.complete(grant.id, { wrappedKeyCid });
        continue;
      }
      const keys = deriveSpaceKeys(
        this.ctx.vault.amk("sharing"),
        grant.spaceId,
        grant.spaceKeyEpoch,
      );
      const wrappedKeyCid = await this.storeGrantKey(
        await sealSpaceKeyring(grant.spaceId, keys, [recipientKey]),
      );
      await this.complete(grant.id, { wrappedKeyCid, keyEpoch: grant.spaceKeyEpoch });
    }
    return items.length;
  }

  // ── What others shared with you ─────────────────────────────────────────────────────────────

  /** Opens a received grant's key on this device (a space keyring or a file manifest). */
  async open(grantId: string): Promise<ReceivedKeys> {
    const cached = this.ctx.vault.receivedKeys(grantId);
    if (cached) return cached;
    const shared = await unwrap(
      this.ctx.transport.api.GET("/v1/shared/{grantId}", { params: { path: { grantId } } }),
    );
    const sealed = await this.ctx.transport.bytes(`/v1/shared/${grantId}/key`);
    const identity = this.ctx.vault.identity();
    const keys: ReceivedKeys = shared.objectId
      ? { kind: "file", manifest: await openManifest(sealed, identity) }
      : { kind: "space", ...(await openSpaceKeyring(sealed, identity)) };
    this.ctx.vault.rememberReceived(grantId, keys);
    return keys;
  }

  /** What a received grant opens, with its name decrypted here (space name, or the file's). */
  async details(grantId: string): Promise<SharedDetails> {
    const { encryptedName, ...shared } = await unwrap(
      this.ctx.transport.api.GET("/v1/shared/{grantId}", { params: { path: { grantId } } }),
    );
    const keys = await this.open(grantId);
    const name =
      keys.kind === "file"
        ? keys.manifest.name
        : await openText(encryptedName, keyringIdentities(keys.keys));
    return { ...shared, name };
  }

  /** Files a received grant lets you open, names decrypted here. */
  async files(
    grantId: string,
    query: { folderId?: string; cursor?: string; limit?: number } = {},
  ): Promise<{ items: FileInfo[]; nextCursor: string | null }> {
    const keys = await this.open(grantId);
    const page = await unwrap(
      this.ctx.transport.api.GET("/v1/shared/{grantId}/objects", {
        params: { path: { grantId }, query: { kind: "file", ...query } },
      }),
    );
    return {
      items: await Promise.all(
        page.items.map(async (raw) => {
          if (keys.kind === "space") return openFileInfo(raw, keyringIdentities(keys.keys));
          const info = await openFileInfo(raw, []);
          return {
            ...info,
            name: keys.manifest.name,
            mime: keys.manifest.mime,
            size: keys.manifest.size,
          };
        }),
      ),
      nextCursor: page.nextCursor,
    };
  }

  /** Downloads and decrypts a file shared with you. */
  async get(grantId: string, objectId: string) {
    const keys = await this.open(grantId);
    const detail = await this.sharedDetail(grantId, objectId);
    if (keys.kind === "file") {
      return readObject(
        this.ctx,
        detail,
        [],
        (id) => this.sharedDetail(grantId, id),
        keys.manifest,
      );
    }
    return readObject(this.ctx, detail, keyringIdentities(keys.keys), (id) =>
      this.sharedDetail(grantId, id),
    );
  }

  private sharedDetail(grantId: string, objectId: string): Promise<ObjectDetail> {
    return unwrap(
      this.ctx.transport.api.GET("/v1/shared/{grantId}/objects/{objectId}", {
        params: { path: { grantId, objectId } },
      }),
    );
  }

  private detail(id: string): Promise<ObjectDetail> {
    return unwrap(this.ctx.transport.api.GET("/v1/objects/{id}", { params: { path: { id } } }));
  }

  /** The owner opens their own manifest with the epoch it was sealed with. */
  private async ownManifest(detail: ObjectDetail): Promise<FileManifest> {
    if (!detail.spaceId || detail.keyEpoch === null || !detail.cid) {
      throw new MemDotError(409, "NOT_STORED", "That file is not stored yet.");
    }
    return openManifest(
      await this.ctx.transport.bytes(`/v1/cids/${detail.cid}`),
      this.ctx.vault.ownedIdentities(detail.spaceId, detail.keyEpoch).slice(0, 1),
    );
  }

  /** The recipient's sealing key, or null when they have not set up MemDot yet. */
  private async recipientKey(to: ShareTarget): Promise<string | null> {
    if ("agentKey" in to) return to.agentKey;
    const recipient = await this.recipient(to.address);
    return recipient.registered ? recipient.encryptionKey : null;
  }

  /** Stores a sealed key as a grant key object (an account object, renewed like any blob). */
  private async storeGrantKey(sealed: Uint8Array): Promise<string> {
    const declared = await storeObject(this.ctx, {
      kind: "grant_key",
      sizeBytes: sealed.length,
      root: sealed,
    });
    if (!declared.object.cid) throw new Error("grant key has no CID");
    return declared.object.cid;
  }

  private create(input: {
    spaceId: string;
    objectId?: string;
    to: ShareTarget;
    options: ShareOptions;
    wrappedKeyCid?: string;
    keyEpoch?: number;
  }): Promise<Grant> {
    return unwrap(
      this.ctx.transport.api.POST("/v1/grants", {
        body: {
          spaceId: input.spaceId,
          grantee:
            "address" in input.to
              ? { kind: "account", address: input.to.address }
              : { kind: "agent", agentId: input.to.agentId },
          scope: input.options.scope ?? "read",
          ...(input.objectId ? { objectId: input.objectId } : {}),
          ...(input.options.expiresAt ? { expiresAt: input.options.expiresAt } : {}),
          ...(input.wrappedKeyCid ? { wrappedKeyCid: input.wrappedKeyCid } : {}),
          ...(input.keyEpoch !== undefined ? { keyEpoch: input.keyEpoch } : {}),
        },
      }),
    );
  }

  private complete(grantId: string, body: { wrappedKeyCid: string; keyEpoch?: number }) {
    return unwrap(
      this.ctx.transport.api.POST("/v1/grants/{id}/complete", {
        params: { path: { id: grantId } },
        body,
      }),
    );
  }
}
