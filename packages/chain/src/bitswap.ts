import { BITSWAP_TIMEOUT_MS } from "@memdot/config";
import type { PolkadotClient } from "polkadot-api";
import { contentHash, contentHashFromCid, toBytes } from "./cid.js";

export class IntegrityError extends Error {
  constructor(readonly cid: string) {
    super(`bytes returned for ${cid} do not match its content hash`);
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`bitswap_v1_get timed out for ${cid}`)), timeoutMs);
  });
  try {
    const hex = await Promise.race([
      client._request<string, [string]>("bitswap_v1_get", [cid]),
      timeout,
    ]);
    const bytes = toBytes(hex);
    const expected = contentHashFromCid(cid);
    const actual = contentHash(bytes);
    if (!actual.every((byte, i) => byte === expected[i])) throw new IntegrityError(cid);
    return bytes;
  } finally {
    clearTimeout(timer);
  }
}
