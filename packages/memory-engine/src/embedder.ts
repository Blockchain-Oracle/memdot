/** Turns texts into vectors. Queries and documents can embed differently on some models. */
export interface Embedder {
  readonly modelId: string;
  readonly dimensions: number;
  embed(texts: string[], purpose: "document" | "query"): Promise<number[][]>;
}

/**
 * The model Private namespaces embed with, on the device. Vectors from another model or
 * quantization aren't comparable, so this is recorded in every index snapshot.
 */
export const LOCAL_EMBEDDING_MODEL = {
  id: "Xenova/all-MiniLM-L6-v2",
  dtype: "q8",
  dimensions: 384,
} as const;

/** Dot product of two unit vectors: their cosine similarity. */
export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < a.length; i += 1) sum += (a[i] as number) * (b[i] as number);
  return sum;
}

export function unitLength(vector: number[]): number[] {
  const length = Math.hypot(...vector);
  return length === 0 ? vector : vector.map((value) => value / length);
}
