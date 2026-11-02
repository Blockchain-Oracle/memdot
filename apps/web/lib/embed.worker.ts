import { pipeline } from "@huggingface/transformers";
import { LOCAL_EMBEDDING_MODEL } from "@memdot/memory-engine";

/** Embeds off the main thread, so typing never waits on the model. It downloads once, then caches. */
type Extractor = (
  texts: string[],
  options: { pooling: "mean"; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

let extractor: Promise<Extractor> | null = null;

function load(): Promise<Extractor> {
  extractor ??= pipeline("feature-extraction", LOCAL_EMBEDDING_MODEL.id, {
    dtype: LOCAL_EMBEDDING_MODEL.dtype,
    progress_callback: (progress: { status: string; progress?: number }) => {
      if (progress.status === "progress") {
        postMessage({ kind: "loading", percent: progress.progress ?? 0 });
      }
    },
  }) as unknown as Promise<Extractor>;
  return extractor;
}

addEventListener("message", async (event: MessageEvent<{ id: number; texts: string[] }>) => {
  const { id, texts } = event.data;
  try {
    const run = await load();
    const output = await run(texts, { pooling: "mean", normalize: true });
    postMessage({ kind: "done", id, vectors: output.tolist() });
  } catch (error) {
    postMessage({
      kind: "failed",
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
