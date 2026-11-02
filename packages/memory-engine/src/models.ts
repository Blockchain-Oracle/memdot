import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { APICallError, embedMany, type LanguageModel } from "ai";
import type { Embedder } from "./embedder.js";
import { type EmbeddingConfig, type LlmConfig, SERVER_EMBEDDING_DIMENSIONS } from "./providers.js";

/** The server passes a fetch that refuses private addresses; a browser or script needs none. */
type Fetch = typeof globalThis.fetch;

function oneModel(config: LlmConfig, model: string, fetch?: Fetch): LanguageModel {
  const base = { apiKey: config.apiKey, ...(fetch ? { fetch } : {}) };
  switch (config.provider) {
    case "google":
      return createGoogleGenerativeAI(base)(model);
    case "openai":
      return createOpenAI(base)(model);
    case "anthropic":
      // Private namespaces call the provider straight from the browser, with the user's own key.
      return createAnthropic({
        ...base,
        headers: { "anthropic-dangerous-direct-browser-access": "true" },
      })(model);
    case "openai-compatible": {
      if (!config.baseUrl) throw new Error("An OpenAI-compatible provider needs a base URL.");
      return createOpenAICompatible({ ...base, name: "custom", baseURL: config.baseUrl })(model);
    }
  }
}

/** How long a model that hit its quota is left alone before it's asked again. */
const QUOTA_COOLDOWN_MS = 60_000;

type ConcreteModel = Exclude<LanguageModel, string>;

/** Over quota or down at the provider: another model may well answer. */
const worthTryingNext = (error: unknown) =>
  APICallError.isInstance(error) && (error.statusCode === 429 || (error.statusCode ?? 0) >= 500);

/** Asks each model in turn, skipping any that recently said it was over its quota. */
function modelWithFallbacks(models: ConcreteModel[]): LanguageModel {
  const first = models[0] as ConcreteModel;
  const restingUntil = new Map<ConcreteModel, number>();
  async function attempt<T>(call: (model: ConcreteModel) => PromiseLike<T>): Promise<T> {
    const now = Date.now();
    const awake = models.filter((model) => (restingUntil.get(model) ?? 0) <= now);
    let lastError: unknown;
    for (const model of awake.length ? awake : models) {
      try {
        return await call(model);
      } catch (error) {
        if (!worthTryingNext(error)) throw error;
        restingUntil.set(model, Date.now() + QUOTA_COOLDOWN_MS);
        lastError = error;
      }
    }
    throw lastError;
  }
  return {
    ...first,
    provider: first.provider,
    modelId: models.map((model) => model.modelId).join(","),
    specificationVersion: first.specificationVersion,
    supportedUrls: first.supportedUrls,
    doGenerate: (options: never) =>
      attempt((model) =>
        (model as { doGenerate: (o: never) => PromiseLike<unknown> }).doGenerate(options),
      ),
    doStream: (options: never) =>
      attempt((model) =>
        (model as { doStream: (o: never) => PromiseLike<unknown> }).doStream(options),
      ),
  } as unknown as LanguageModel;
}

/**
 * The model for a configuration. `model` may list several, comma-separated: the next one takes
 * over whenever one is over its quota or down, in order.
 */
export function languageModel(config: LlmConfig, fetch?: Fetch): LanguageModel {
  const ids = config.model
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  if (ids.length <= 1) return oneModel(config, ids[0] ?? config.model, fetch);
  return modelWithFallbacks(ids.map((id) => oneModel(config, id, fetch) as ConcreteModel));
}

/** Embeddings through the AI SDK, at a fixed size so every vector fits one index. */
export function providerEmbedder(
  config: EmbeddingConfig,
  dimensions = SERVER_EMBEDDING_DIMENSIONS,
  fetch?: Fetch,
): Embedder {
  const base = { apiKey: config.apiKey, ...(fetch ? { fetch } : {}) };
  const model = (() => {
    switch (config.provider) {
      case "google":
        return createGoogleGenerativeAI(base).embedding(config.model);
      case "openai":
        return createOpenAI(base).embedding(config.model);
      case "openai-compatible": {
        if (!config.baseUrl) throw new Error("An OpenAI-compatible provider needs a base URL.");
        return createOpenAICompatible({
          ...base,
          name: "custom",
          baseURL: config.baseUrl,
        }).embeddingModel(config.model);
      }
    }
  })();
  return {
    modelId: `${config.provider}:${config.model}`,
    dimensions,
    async embed(texts, purpose) {
      if (texts.length === 0) return [];
      const { embeddings } = await embedMany({
        model,
        values: texts,
        maxRetries: 3,
        providerOptions: {
          google: {
            outputDimensionality: dimensions,
            taskType: purpose === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
          },
          openai: { dimensions },
          custom: { dimensions },
        },
      });
      return embeddings;
    },
  };
}
