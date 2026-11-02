import { type Database, memoryConfig } from "@memdot/db";
import type {
  Embedder,
  EmbeddingConfig,
  EmbeddingProvider,
  LlmConfig,
  LlmProvider,
} from "@memdot/memory-engine";
import { languageModel, providerEmbedder } from "@memdot/memory-engine/llm";
import type { LanguageModel } from "ai";
import { eq } from "drizzle-orm";
import type { MemoryEnv } from "./env.js";
import type { AssistedKeys } from "./keys.js";
import { safeFetch } from "./safe-fetch.js";

type Selectable = Pick<Database, "select">;

export interface AccountModels {
  llm: LanguageModel | null;
  embedder: Embedder | null;
  /** On MemDot's own key, so the daily limit applies. */
  sharedLlm: boolean;
}

interface StoredChoice {
  provider: string;
  model: string;
  baseUrl?: string;
}

function defaultLlm(env: MemoryEnv): LlmConfig | null {
  if (!env.MEMORY_LLM_PROVIDER || !env.MEMORY_LLM_MODEL || !env.MEMORY_LLM_API_KEY) return null;
  return {
    provider: env.MEMORY_LLM_PROVIDER,
    model: env.MEMORY_LLM_MODEL,
    apiKey: env.MEMORY_LLM_API_KEY,
    ...(env.MEMORY_LLM_BASE_URL ? { baseUrl: env.MEMORY_LLM_BASE_URL } : {}),
  };
}

function defaultEmbedder(env: MemoryEnv): EmbeddingConfig | null {
  if (
    !env.MEMORY_EMBEDDING_PROVIDER ||
    !env.MEMORY_EMBEDDING_MODEL ||
    !env.MEMORY_EMBEDDING_API_KEY
  ) {
    return null;
  }
  return {
    provider: env.MEMORY_EMBEDDING_PROVIDER,
    model: env.MEMORY_EMBEDDING_MODEL,
    apiKey: env.MEMORY_EMBEDDING_API_KEY,
    ...(env.MEMORY_EMBEDDING_BASE_URL ? { baseUrl: env.MEMORY_EMBEDDING_BASE_URL } : {}),
  };
}

/** The models an account's Assisted writes and searches use: its own, else the service's. */
export async function modelsFor(
  db: Selectable,
  keys: AssistedKeys,
  env: MemoryEnv,
  accountId: string,
): Promise<AccountModels> {
  const [row] = await db.select().from(memoryConfig).where(eq(memoryConfig.accountId, accountId));
  const choice = (stored: unknown) => stored as StoredChoice | null | undefined;
  const llmChoice = choice(row?.llm);
  const embedderChoice = choice(row?.embedder);
  const ownLlm: LlmConfig | null =
    llmChoice && row?.llmKeySealed
      ? {
          provider: llmChoice.provider as LlmProvider,
          model: llmChoice.model,
          apiKey: keys.openForAccount(accountId, row.llmKeySealed),
          ...(llmChoice.baseUrl ? { baseUrl: llmChoice.baseUrl } : {}),
        }
      : null;
  const ownEmbedder: EmbeddingConfig | null =
    embedderChoice && row?.embedderKeySealed
      ? {
          provider: embedderChoice.provider as EmbeddingProvider,
          model: embedderChoice.model,
          apiKey: keys.openForAccount(accountId, row.embedderKeySealed),
          ...(embedderChoice.baseUrl ? { baseUrl: embedderChoice.baseUrl } : {}),
        }
      : null;
  const llmConfig = ownLlm ?? defaultLlm(env);
  const embedderConfig = ownEmbedder ?? defaultEmbedder(env);
  return {
    // An account's own address could point anywhere, so its calls go through the guarded fetch.
    llm: llmConfig ? languageModel(llmConfig, ownLlm?.baseUrl ? safeFetch : undefined) : null,
    embedder: embedderConfig
      ? providerEmbedder(embedderConfig, undefined, ownEmbedder?.baseUrl ? safeFetch : undefined)
      : null,
    sharedLlm: !ownLlm && llmConfig !== null,
  };
}
