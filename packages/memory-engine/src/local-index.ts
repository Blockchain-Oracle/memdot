import { dot } from "./embedder.js";
import { termFrequencies } from "./tokenize.js";

const MAGIC = new TextEncoder().encode("MDIDX1");
const HEADER_LENGTH_BYTES = 4;
/** Vectors are unit length, so each component fits a signed byte with little loss. */
const INT8_SCALE = 127;
const BM25_K1 = 1.2;
const BM25_B = 0.75;

export interface SnapshotHeader {
  v: 1;
  modelId: string;
  dtype: string;
  dimensions: number;
  /** Memory ids with their versions, in matrix order. A changed version means re-embed. */
  ids: string[];
  versions: number[];
  at: string;
}

interface Document {
  version: number;
  vector: Float32Array | null;
  terms: Map<string, number>;
  length: number;
}

/**
 * A Private namespace's index, in memory on the device. Brute force is fast at this scale (tens of
 * thousands of memories), and the whole index fits one encrypted snapshot on V3.
 */
export class LocalIndex {
  private readonly docs = new Map<string, Document>();
  /** How many live documents hold each term. */
  private readonly documentFrequency = new Map<string, number>();
  private totalLength = 0;

  constructor(
    readonly modelId: string,
    readonly dtype: string,
    readonly dimensions: number,
  ) {}

  get size(): number {
    return this.docs.size;
  }

  ids(): string[] {
    return [...this.docs.keys()];
  }

  version(id: string): number | undefined {
    return this.docs.get(id)?.version;
  }

  hasVector(id: string): boolean {
    return (this.docs.get(id)?.vector ?? null) !== null;
  }

  put(id: string, version: number, text: string, vector?: ArrayLike<number> | null): void {
    this.remove(id);
    const terms = termFrequencies(text);
    let length = 0;
    for (const [term, count] of terms) {
      length += count;
      this.documentFrequency.set(term, (this.documentFrequency.get(term) ?? 0) + 1);
    }
    this.totalLength += length;
    this.docs.set(id, {
      version,
      terms,
      length,
      vector: vector ? Float32Array.from(vector) : null,
    });
  }

  setVector(id: string, vector: ArrayLike<number>): void {
    const doc = this.docs.get(id);
    if (doc) doc.vector = Float32Array.from(vector);
  }

  remove(id: string): void {
    const doc = this.docs.get(id);
    if (!doc) return;
    for (const term of doc.terms.keys()) {
      const left = (this.documentFrequency.get(term) ?? 1) - 1;
      if (left === 0) this.documentFrequency.delete(term);
      else this.documentFrequency.set(term, left);
    }
    this.totalLength -= doc.length;
    this.docs.delete(id);
  }

  /** Cosine similarity for every document that has a vector, best first. */
  semantic(
    query: ArrayLike<number>,
    limit: number,
    allow?: (id: string) => boolean,
  ): { id: string; score: number }[] {
    const scored: { id: string; score: number }[] = [];
    for (const [id, doc] of this.docs) {
      if (!doc.vector || (allow && !allow(id))) continue;
      scored.push({ id, score: dot(query, doc.vector) });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** Okapi BM25 over the query's terms, best first. */
  keyword(
    queryTerms: string[],
    limit: number,
    allow?: (id: string) => boolean,
  ): { id: string; score: number }[] {
    if (this.docs.size === 0) return [];
    const average = this.totalLength / this.docs.size || 1;
    const unique = [...new Set(queryTerms)];
    const scored: { id: string; score: number }[] = [];
    for (const [id, doc] of this.docs) {
      if (allow && !allow(id)) continue;
      let score = 0;
      for (const term of unique) {
        const tf = doc.terms.get(term);
        if (!tf) continue;
        const df = this.documentFrequency.get(term) ?? 0;
        const idf = Math.log(1 + (this.docs.size - df + 0.5) / (df + 0.5));
        score +=
          (idf * (tf * (BM25_K1 + 1))) /
          (tf + BM25_K1 * (1 - BM25_B + (BM25_B * doc.length) / average));
      }
      if (score > 0) scored.push({ id, score });
    }
    return scored.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** Vectors at one byte per component, so a snapshot costs a quarter of the tPOT. */
  toSnapshot(at: string): Uint8Array {
    const entries = [...this.docs].filter(([, doc]) => doc.vector);
    const header: SnapshotHeader = {
      v: 1,
      modelId: this.modelId,
      dtype: this.dtype,
      dimensions: this.dimensions,
      ids: entries.map(([id]) => id),
      versions: entries.map(([, doc]) => doc.version),
      at,
    };
    const headerBytes = new TextEncoder().encode(JSON.stringify(header));
    const start = MAGIC.length + HEADER_LENGTH_BYTES + headerBytes.length;
    const out = new Uint8Array(start + entries.length * this.dimensions);
    out.set(MAGIC);
    new DataView(out.buffer).setUint32(MAGIC.length, headerBytes.length);
    out.set(headerBytes, MAGIC.length + HEADER_LENGTH_BYTES);
    const matrix = new Int8Array(out.buffer, start);
    entries.forEach(([, doc], row) => {
      const vector = doc.vector as Float32Array;
      for (let i = 0; i < this.dimensions; i += 1) {
        matrix[row * this.dimensions + i] = Math.round((vector[i] as number) * INT8_SCALE);
      }
    });
    return out;
  }
}

/** Vectors in a snapshot, keyed by memory id. Null when the embedding model has changed. */
export function readSnapshot(
  bytes: Uint8Array,
  expected: { modelId: string; dtype: string; dimensions: number },
): Map<string, { version: number; vector: Float32Array }> | null {
  if (!MAGIC.every((byte, i) => bytes[i] === byte)) throw new Error("not a MemDot index snapshot");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLength = view.getUint32(MAGIC.length);
  const start = MAGIC.length + HEADER_LENGTH_BYTES;
  const header = JSON.parse(
    new TextDecoder().decode(bytes.subarray(start, start + headerLength)),
  ) as SnapshotHeader;
  if (
    header.v !== 1 ||
    header.modelId !== expected.modelId ||
    header.dtype !== expected.dtype ||
    header.dimensions !== expected.dimensions
  ) {
    return null;
  }
  const matrix = new Int8Array(
    bytes.buffer,
    bytes.byteOffset + start + headerLength,
    header.ids.length * header.dimensions,
  );
  const vectors = new Map<string, { version: number; vector: Float32Array }>();
  header.ids.forEach((id, row) => {
    const vector = new Float32Array(header.dimensions);
    for (let i = 0; i < header.dimensions; i += 1) {
      vector[i] = (matrix[row * header.dimensions + i] as number) / INT8_SCALE;
    }
    vectors.set(id, { version: header.versions[row] as number, vector });
  });
  return vectors;
}
