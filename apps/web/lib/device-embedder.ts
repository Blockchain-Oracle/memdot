import { type Embedder, LOCAL_EMBEDDING_MODEL } from "@memdot/memory-engine";

type Reply =
  | { kind: "loading"; percent: number }
  | { kind: "done"; id: number; vectors: number[][] }
  | { kind: "failed"; id: number; error: string };

let worker: Worker | null = null;
let nextId = 0;
const waiting = new Map<number, { resolve: (v: number[][]) => void; reject: (e: Error) => void }>();
const listeners = new Set<(percent: number | null) => void>();
let lastPercent: number | null = null;

function publish(percent: number | null) {
  lastPercent = percent;
  for (const listener of listeners) listener(percent);
}

function start(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./embed.worker.ts", import.meta.url), { type: "module" });
  worker.addEventListener("message", (event: MessageEvent<Reply>) => {
    const reply = event.data;
    if (reply.kind === "loading") {
      publish(reply.percent);
      return;
    }
    publish(null);
    const pending = waiting.get(reply.id);
    waiting.delete(reply.id);
    if (reply.kind === "done") pending?.resolve(reply.vectors);
    else pending?.reject(new Error(reply.error));
  });
  return worker;
}

/** Private namespaces' embedder: a local model in a Web Worker. Nothing it reads leaves the tab. */
export const deviceEmbedder: Embedder = {
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

/** The model's first download, for showing progress. Null when nothing is downloading. */
export function subscribeToModelDownload(listener: (percent: number | null) => void) {
  listeners.add(listener);
  listener(lastPercent);
  return () => listeners.delete(listener);
}
