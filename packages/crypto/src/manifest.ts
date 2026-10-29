import { utf8ToBytes } from "@noble/hashes/utils.js";
import { base64 } from "@scure/base";
import { openWith, sealTo } from "./age.js";

/**
 * Everything needed to read a file: its key, size and chunk CIDs. Sealed to the space recipient,
 * and re-sealed to a grantee to share one file without touching the chunks.
 */
export interface FileManifest {
  v: 1;
  kind: "file";
  name: string;
  mime: string;
  size: number;
  paddedSize: number;
  objectKey: string;
  chunks: { cid: string; bytes: number }[];
  createdAt: string;
}

export interface ManifestInput extends Omit<FileManifest, "v" | "kind" | "objectKey"> {
  objectKey: Uint8Array;
}

export function buildManifest(input: ManifestInput): FileManifest {
  return { v: 1, kind: "file", ...input, objectKey: base64.encode(input.objectKey) };
}

export function manifestObjectKey(manifest: FileManifest): Uint8Array {
  return base64.decode(manifest.objectKey);
}

export function sealManifest(manifest: FileManifest, recipients: string[]): Promise<Uint8Array> {
  return sealTo(utf8ToBytes(JSON.stringify(manifest)), recipients);
}

export async function openManifest(
  ciphertext: Uint8Array,
  identity: string,
): Promise<FileManifest> {
  const manifest = JSON.parse(
    new TextDecoder().decode(await openWith(ciphertext, identity, "the manifest")),
  ) as FileManifest;
  if (manifest.v !== 1 || manifest.kind !== "file") throw new Error("unsupported manifest");
  return manifest;
}
