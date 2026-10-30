import { openWith, sealTo } from "@memdot/crypto";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import type { Context, Schemas } from "./context.js";
import { unwrap } from "./transport.js";

export type RawSpace = Schemas["Space"];
export type RawFolder = Schemas["Folder"];

export interface Space extends Omit<RawSpace, "encryptedName"> {
  /** Decrypted on this device; null while locked. */
  name: string | null;
}

export interface Folder extends Omit<RawFolder, "encryptedName"> {
  name: string | null;
}

export const fromBase64 = (value: string) =>
  Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
export const toBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

/** Opens a sealed name with any of the identities; null when none of them fits. */
export async function openText(
  sealed: string | null,
  identities: string[],
): Promise<string | null> {
  if (!sealed || identities.length === 0) return null;
  try {
    return new TextDecoder().decode(await openWith(fromBase64(sealed), identities));
  } catch {
    return null;
  }
}

export async function sealText(text: string, recipient: string): Promise<string> {
  return toBase64(await sealTo(utf8ToBytes(text), [recipient]));
}

export class SpacesApi {
  constructor(private readonly ctx: Context) {}

  /**
   * Creates a space. Its id is chosen here so the name can be sealed with the space's own key
   * (epoch 0) before the API ever sees it.
   */
  async create(input: { name: string; mode?: RawSpace["mode"] }): Promise<Space> {
    const id = crypto.randomUUID();
    const encryptedName = await sealText(input.name, this.ctx.vault.sealTo(id, 0));
    const raw = await unwrap(
      this.ctx.transport.api.POST("/v1/spaces", {
        body: { id, encryptedName, mode: input.mode ?? "sponsored" },
      }),
    );
    return this.open(raw);
  }

  async list(): Promise<Space[]> {
    const { items } = await unwrap(this.ctx.transport.api.GET("/v1/spaces"));
    return Promise.all(items.map((raw) => this.open(raw)));
  }

  async get(id: string): Promise<Space> {
    return this.open(await this.raw(id));
  }

  raw(id: string): Promise<RawSpace> {
    return unwrap(this.ctx.transport.api.GET("/v1/spaces/{id}", { params: { path: { id } } }));
  }

  async rename(id: string, name: string): Promise<Space> {
    const space = await this.raw(id);
    const encryptedName = await sealText(name, this.ctx.vault.sealTo(id, space.keyEpoch));
    return this.open(
      await unwrap(
        this.ctx.transport.api.PATCH("/v1/spaces/{id}", {
          params: { path: { id } },
          body: { encryptedName },
        }),
      ),
    );
  }

  /** Who signs future writes: MemDot's relayer (sponsored) or your wallet (self-signed). */
  async setMode(id: string, mode: RawSpace["mode"]): Promise<Space> {
    return this.open(
      await unwrap(
        this.ctx.transport.api.PATCH("/v1/spaces/{id}", {
          params: { path: { id } },
          body: { mode },
        }),
      ),
    );
  }

  /** Tombstones everything in it and stops renewing; bytes expire from the chain within 7 days. */
  delete(id: string) {
    return unwrap(this.ctx.transport.api.DELETE("/v1/spaces/{id}", { params: { path: { id } } }));
  }

  private async open(raw: RawSpace): Promise<Space> {
    const { encryptedName, ...rest } = raw;
    const identities = this.ctx.vault.unlocked
      ? this.ctx.vault.ownedIdentities(raw.id, raw.keyEpoch)
      : [];
    return { ...rest, name: await openText(encryptedName, identities) };
  }
}

export class FoldersApi {
  constructor(
    private readonly ctx: Context,
    private readonly spaces: SpacesApi,
  ) {}

  async create(
    spaceId: string,
    input: { name: string; parentId?: string | null; memoryMode?: RawFolder["memoryMode"] },
  ): Promise<Folder> {
    const space = await this.spaces.raw(spaceId);
    const encryptedName = await sealText(
      input.name,
      this.ctx.vault.sealTo(spaceId, space.keyEpoch),
    );
    const raw = await unwrap(
      this.ctx.transport.api.POST("/v1/spaces/{spaceId}/folders", {
        params: { path: { spaceId } },
        body: {
          encryptedName,
          parentId: input.parentId ?? null,
          memoryMode: input.memoryMode ?? "off",
        },
      }),
    );
    return this.open(raw, space.keyEpoch);
  }

  async list(spaceId: string): Promise<Folder[]> {
    const space = await this.spaces.raw(spaceId);
    const { items } = await unwrap(
      this.ctx.transport.api.GET("/v1/spaces/{spaceId}/folders", {
        params: { path: { spaceId } },
      }),
    );
    return Promise.all(items.map((raw) => this.open(raw, space.keyEpoch)));
  }

  async rename(id: string, spaceId: string, name: string): Promise<Folder> {
    const space = await this.spaces.raw(spaceId);
    const encryptedName = await sealText(name, this.ctx.vault.sealTo(spaceId, space.keyEpoch));
    const raw = await unwrap(
      this.ctx.transport.api.PATCH("/v1/folders/{id}", {
        params: { path: { id } },
        body: { encryptedName },
      }),
    );
    return this.open(raw, space.keyEpoch);
  }

  async move(id: string, parentId: string | null): Promise<RawFolder> {
    return unwrap(
      this.ctx.transport.api.PATCH("/v1/folders/{id}", {
        params: { path: { id } },
        body: { parentId },
      }),
    );
  }

  delete(id: string) {
    return unwrap(this.ctx.transport.api.DELETE("/v1/folders/{id}", { params: { path: { id } } }));
  }

  private async open(raw: RawFolder, throughEpoch: number): Promise<Folder> {
    const { encryptedName, ...rest } = raw;
    const identities = this.ctx.vault.unlocked
      ? this.ctx.vault.ownedIdentities(raw.spaceId, throughEpoch)
      : [];
    return { ...rest, name: await openText(encryptedName, identities) };
  }
}
