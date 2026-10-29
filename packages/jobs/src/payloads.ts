import { z } from "zod";
import { RENEW_BATCH_SIZE } from "./queues.js";

/** Store one blob (a root or a data chunk) whose ciphertext waits in `blob_staging`. */
export const storeBlobPayload = z.object({
  action: z.literal("store"),
  jobId: z.uuid(),
  storedItemId: z.uuid(),
});

/** Renew up to RENEW_BATCH_SIZE stored items; each is its own top-level `renew` extrinsic. */
export const renewBatchPayload = z.object({
  action: z.literal("renew"),
  storedItemIds: z.array(z.uuid()).min(1).max(RENEW_BATCH_SIZE),
  /** Set when a user asked for "Renew now", so their job reports the result. */
  jobId: z.uuid().optional(),
});

export const chainTxPayload = z.discriminatedUnion("action", [storeBlobPayload, renewBatchPayload]);

export type StoreBlobPayload = z.infer<typeof storeBlobPayload>;
export type RenewBatchPayload = z.infer<typeof renewBatchPayload>;
export type ChainTxPayload = z.infer<typeof chainTxPayload>;
