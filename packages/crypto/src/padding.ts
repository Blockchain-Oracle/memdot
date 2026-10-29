/**
 * Padmé padding: rounds a length up so at most O(log log L) bits of it leak, costing at most
 * ~12% overhead. Stored objects are padded so their size does not reveal the exact file size.
 */
export function padmeLength(length: number): number {
  if (length < 2) return length;
  const e = Math.floor(Math.log2(length));
  const s = Math.floor(Math.log2(e)) + 1;
  const lastBits = e - s;
  const mask = 2 ** lastBits - 1;
  return Math.ceil((length + mask) / (mask + 1)) * (mask + 1);
}

export function padTo(data: Uint8Array, length: number): Uint8Array {
  if (length < data.length) throw new Error("padding length is shorter than the data");
  if (length === data.length) return data;
  const padded = new Uint8Array(length);
  padded.set(data);
  return padded;
}
