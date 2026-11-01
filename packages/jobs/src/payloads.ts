import { z } from "zod";
import { RENEW_BATCH_SIZE } from "./queues.js";

/** Store one blob (a root or a data chunk) whose ciphertext waits in `blob_staging`. */
export const storeBlobPayload = z.object({
  action: z.literal("store"),
  jobId: z.uuid(),
  storedItemId: z.uuid(),
});

/**
 * Renew up to RENEW_BATCH_SIZE stored items; each is its own top-level `renew` extrinsic.
 * `atBlock` is where the item lived when this was queued: if it has moved since, it was already
 * renewed and is skipped, so a repeated job never pays twice.
 */
export const renewBatchPayload = z.object({
  action: z.literal("renew"),
  items: z
    .array(z.object({ id: z.uuid(), atBlock: z.number().int().positive() }))
    .min(1)
    .max(RENEW_BATCH_SIZE),
  /** Set when a user asked for "Renew now", so their job reports the result. */
  jobId: z.uuid().optional(),
});

/** Submit one owner-signed `MemDotRegistry.record` call, already checked by the API. */
export const registryPayload = z.object({
  action: z.literal("registry"),
  calldata: z.string().regex(/^0x[0-9a-f]+$/i),
});

export const chainTxPayload = z.discriminatedUnion("action", [
  storeBlobPayload,
  renewBatchPayload,
  registryPayload,
]);

export type StoreBlobPayload = z.infer<typeof storeBlobPayload>;
export type RenewBatchPayload = z.infer<typeof renewBatchPayload>;
export type RegistryPayload = z.infer<typeof registryPayload>;
export type ChainTxPayload = z.infer<typeof chainTxPayload>;
