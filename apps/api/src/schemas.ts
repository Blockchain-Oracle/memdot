import { z } from "@hono/zod-openapi";
import { contentHashFromCid } from "@memdot/chain";
import { MAX_ENCRYPTED_META_BYTES, MAX_PAGE_SIZE, PAGE_SIZE } from "@memdot/config";

// Shared wire schemas. Ids, CIDs, hashes and addresses use one format everywhere (R9).

export const Uuid = z.uuid().openapi({ example: "0b8d3f4e-6a1c-4f7e-9a51-2c3d4e5f6a7b" });

export const Cid = z
  .string()
  .refine((value) => {
    try {
      contentHashFromCid(value);
      return true;
    } catch {
      return false;
    }
  }, "Not a MemDot CID (CIDv1, raw, blake2b-256).")
  .openapi({
    description: "CIDv1 (raw codec, blake2b-256) of the stored bytes",
    example: "bafk2bzacecwzr3f6a5yqkxyx2t5r5mmdq3ruytubkxqzqx3jr6o2xg6k4bxfa",
  });

export const Hex32 = z
  .string()
  .regex(/^0x[0-9a-f]{64}$/i, "Expected 32 bytes as 0x-hex.")
  .transform((value) => value.toLowerCase())
  .openapi({ example: "0x2a6c…", description: "32 bytes, 0x-hex" });

export const TxHash = Hex32.openapi({ description: "Extrinsic hash" });

/** Ciphertext sealed to a space key, base64. Short: names and metadata only. */
export const SealedText = z
  .base64()
  .refine(
    (value) => Math.floor((value.length * 3) / 4) <= MAX_ENCRYPTED_META_BYTES,
    `At most ${MAX_ENCRYPTED_META_BYTES} bytes.`,
  )
  .openapi({ description: "Encrypted on the client (age, sealed to the space key), base64" });

export const PageQuery = z.object({
  cursor: z.string().optional().openapi({ description: "From the previous page's nextCursor" }),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(PAGE_SIZE),
});

export const pageOf = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

export const IdParam = z.object({ id: Uuid.openapi({ param: { name: "id", in: "path" } }) });

export const toBase64 = (bytes: Uint8Array | null) =>
  bytes ? Buffer.from(bytes).toString("base64") : null;
export const fromBase64 = (value: string) => new Uint8Array(Buffer.from(value, "base64"));
