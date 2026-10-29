import { CHUNK_BYTES } from "@memdot/config";
import { utf8ToBytes } from "@noble/hashes/utils.js";
import { openWith, sealTo } from "./age.js";

/**
 * A segment packs many small items (tiny files, memories) into one stored object, so they cost
 * one store and one renewal instead of one each. Layout before encryption:
 * "MDSEG1" | u32 header length | header JSON | concatenated entry bytes.
 */
const MAGIC = utf8ToBytes("MDSEG1");
const HEADER_LENGTH_BYTES = 4;

export interface SegmentEntry {
  id: string;
  kind: "file" | "memory";
  name?: string;
  mime?: string;
  meta?: Record<string, unknown>;
  data: Uint8Array;
}

interface SegmentHeader {
  v: 1;
  entries: (Omit<SegmentEntry, "data"> & { offset: number; length: number })[];
}

export function packSegment(entries: SegmentEntry[]): Uint8Array {
  let offset = 0;
  const header: SegmentHeader = {
    v: 1,
    entries: entries.map(({ data, ...rest }) => {
      const entry = { ...rest, offset, length: data.length };
      offset += data.length;
      return entry;
    }),
  };
  const headerBytes = utf8ToBytes(JSON.stringify(header));
  const out = new Uint8Array(MAGIC.length + HEADER_LENGTH_BYTES + headerBytes.length + offset);
  out.set(MAGIC);
  new DataView(out.buffer).setUint32(MAGIC.length, headerBytes.length);
  out.set(headerBytes, MAGIC.length + HEADER_LENGTH_BYTES);
  let cursor = MAGIC.length + HEADER_LENGTH_BYTES + headerBytes.length;
  for (const { data } of entries) {
    out.set(data, cursor);
    cursor += data.length;
  }
  return out;
}

export function unpackSegment(bytes: Uint8Array): SegmentEntry[] {
  if (!MAGIC.every((b, i) => bytes[i] === b)) throw new Error("not a MemDot segment");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(MAGIC.length);
  const headerStart = MAGIC.length + HEADER_LENGTH_BYTES;
  const header = JSON.parse(
    new TextDecoder().decode(bytes.subarray(headerStart, headerStart + headerLength)),
  ) as SegmentHeader;
  if (header.v !== 1) throw new Error("unsupported segment version");
  const payload = bytes.subarray(headerStart + headerLength);
  return header.entries.map(({ offset, length, ...rest }) => ({
    ...rest,
    data: payload.slice(offset, offset + length),
  }));
}

/** Seals a segment to one recipient; a segment must fit in a single stored chunk. */
export async function sealSegment(entries: SegmentEntry[], recipient: string): Promise<Uint8Array> {
  const sealed = await sealTo(packSegment(entries), [recipient]);
  if (sealed.length > CHUNK_BYTES) throw new Error("segment exceeds one storage chunk; split it");
  return sealed;
}

export async function openSegment(
  ciphertext: Uint8Array,
  identity: string,
): Promise<SegmentEntry[]> {
  return unpackSegment(await openWith(ciphertext, identity, "the segment"));
}
