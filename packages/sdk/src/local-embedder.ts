import { type Embedder, LOCAL_EMBEDDING_MODEL } from "@memdot/memory-engine";

/** Named indirectly so a browser bundle doesn't pull the model runtime into every page. */
const TRANSFORMERS = "@huggingface/transformers";

/**
 * Embeds on this device, so Private memories never leave it in the clear. Downloads the model once
 * (about 23 MB). In a browser, pass a Worker-backed embedder to `MemDot.create` instead.
 */
export function localEmbedder(): Embedder {
  let extractor: Promise<
    (texts: string[], options: object) => Promise<{ tolist(): number[][] }>
  > | null = null;
  return {
    modelId: LOCAL_EMBEDDING_MODEL.id,
    dimensions: LOCAL_EMBEDDING_MODEL.dimensions,
    async embed(texts) {
      if (texts.length === 0) return [];
      extractor ??= import(/* webpackIgnore: true */ /* turbopackIgnore: true */ TRANSFORMERS).then(
        ({ pipeline }) =>
          pipeline("feature-extraction", LOCAL_EMBEDDING_MODEL.id, {
            dtype: LOCAL_EMBEDDING_MODEL.dtype,
          }),
      );
      const run = await extractor;
      return (await run(texts, { pooling: "mean", normalize: true })).tolist();
    },
  };
}
