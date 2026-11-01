import { BITSWAP_TIMEOUT_MS } from "@memdot/config";
import type { PolkadotClient } from "polkadot-api";
import { contentHash, contentHashFromCid, toBytes } from "./cid.js";

export class IntegrityError extends Error {
  constructor(readonly cid: string) {
    super(`bytes returned for ${cid} do not match its content hash`);
  }
}

/** A node did not answer in time. That says nothing about the data: ask again. */
export class NodeTimeoutError extends Error {}

/** Rejects with NodeTimeoutError when a read takes longer than `timeoutMs`. */
export async function withNodeTimeout<T>(
  read: Promise<T>,
  what: string,
  timeoutMs: number = BITSWAP_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new NodeTimeoutError(`${what} timed out`)), timeoutMs);
  });
  try {
    return await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reads stored bytes by CID through the node's `bitswap_v1_get` RPC and checks them against the
 * hash inside the CID. The RPC is untyped in PAPI, so this is the only place that calls it.
 */
export async function bitswapGet(
  client: PolkadotClient,
  cid: string,
  timeoutMs: number = BITSWAP_TIMEOUT_MS,
): Promise<Uint8Array> {
  const hex = await withNodeTimeout(
    client._request<string, [string]>("bitswap_v1_get", [cid]),
    `bitswap_v1_get for ${cid}`,
    timeoutMs,
  );
  const bytes = toBytes(hex);
  const expected = contentHashFromCid(cid);
  const actual = contentHash(bytes);
  if (!actual.every((byte, i) => byte === expected[i])) throw new IntegrityError(cid);
  return bytes;
}
