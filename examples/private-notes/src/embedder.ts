import { type Embedder, LOCAL_EMBEDDING_MODEL } from "@memdot/memory-engine";

type Reply =
  | { kind: "loading"; percent: number }
  | { kind: "done"; id: number; vectors: number[][] }
  | { kind: "failed"; id: number; error: string };

let worker: Worker | null = null;
let nextId = 0;
const waiting = new Map<number, { resolve: (v: number[][]) => void; reject: (e: Error) => void }>();

/** Called with how far the model's download has got, and null once it's ready. */
export let onModelProgress: (percent: number | null) => void = () => {};
export const listenToModel = (listener: (percent: number | null) => void) => {
  onModelProgress = listener;
};

function start(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./embed.worker.ts", import.meta.url), { type: "module" });
  worker.addEventListener("message", (event: MessageEvent<Reply>) => {
    const reply = event.data;
    if (reply.kind === "loading") {
      onModelProgress(reply.percent);
      return;
    }
    onModelProgress(null);
    const pending = waiting.get(reply.id);
    waiting.delete(reply.id);
    if (reply.kind === "done") pending?.resolve(reply.vectors);
    else pending?.reject(new Error(reply.error));
  });
  return worker;
}

/** A small model in a Web Worker. What it reads never leaves this tab. */
export const browserEmbedder: Embedder = {
  modelId: LOCAL_EMBEDDING_MODEL.id,
  dimensions: LOCAL_EMBEDDING_MODEL.dimensions,
  embed(texts) {
    if (texts.length === 0) return Promise.resolve([]);
    const target = start();
    const id = nextId;
    nextId += 1;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      target.postMessage({ id, texts });
    });
  },
};
