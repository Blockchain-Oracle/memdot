import { LOCAL_EMBEDDING_MODEL } from "@memdot/memory-engine";
import { MemDot as Client, MemDotError } from "@memdot/sdk";
import {
  type IExecuteFunctions,
  type ILoadOptionsFunctions,
  type INodePropertyOptions,
  type ISupplyDataFunctions,
  NodeOperationError,
} from "n8n-workflow";

const CLIENT = "n8n";
export const CREDENTIAL = "memDotApi";
const ID_CHARS = 8;

interface MemDotCredential {
  apiKey: string;
  apiUrl: string;
  identity?: string;
}

/**
 * Private namespaces embed on the device, and n8n has no room for a model runtime. Saying so beats
 * failing on a missing package halfway through.
 */
const noEmbedder = {
  modelId: LOCAL_EMBEDDING_MODEL.id,
  dimensions: LOCAL_EMBEDDING_MODEL.dimensions,
  embed: async (): Promise<number[][]> => {
    throw new MemDotError(
      409,
      "PRIVATE_NAMESPACE",
      "This namespace is Private, which searches with a model on your own device, and n8n can't run one. Use an Assisted namespace here, or the CLI or SDK for this one.",
    );
  },
};

/** A client for this run, from the node's credential. */
export async function clientFor(
  context: IExecuteFunctions | ISupplyDataFunctions | ILoadOptionsFunctions,
): Promise<{ memdot: Client; holdsKeys: boolean }> {
  const credential = (await context.getCredentials(CREDENTIAL)) as unknown as MemDotCredential;
  const memdot = Client.create({
    baseUrl: credential.apiUrl.replace(/\/+$/, ""),
    apiKey: credential.apiKey,
    client: CLIENT,
    embedder: noEmbedder,
    completeGrantsOnUnlock: false,
  });
  const identity = credential.identity?.trim();
  if (identity) memdot.connectAgent({ apiKey: credential.apiKey, identity });
  return { memdot, holdsKeys: Boolean(identity) };
}

/** What a person running the workflow can act on, without a stack trace. */
export function operationError(
  context: IExecuteFunctions | ISupplyDataFunctions,
  error: unknown,
  itemIndex: number,
): NodeOperationError {
  const known = error instanceof MemDotError ? error : null;
  const message =
    known?.status === 401
      ? "MemDot refused this key: it was revoked or has expired."
      : (error as Error).message;
  return new NodeOperationError(context.getNode(), message, {
    itemIndex,
    ...(known?.requestId ? { description: `Request ${known.requestId}` } : {}),
  });
}

/** Names are sealed, so without an identity all there is to show is the mode and an id. */
export async function namespaceOptions(
  this: ILoadOptionsFunctions,
): Promise<INodePropertyOptions[]> {
  const { memdot } = await clientFor(this);
  const namespaces = await memdot.memories.namespaces();
  return namespaces.map((namespace) => ({
    name: `${namespace.name ?? `Namespace ${namespace.id.slice(0, ID_CHARS)}`} (${namespace.mode})`,
    value: namespace.id,
  }));
}

export async function spaceOptions(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
  const { memdot } = await clientFor(this);
  const spaces = await memdot.spaces.list();
  return spaces.map((space) => ({
    name: space.name ?? `Space ${space.id.slice(0, ID_CHARS)}`,
    value: space.id,
  }));
}
