/** Vectors in the Assisted index have this many dimensions; an embedder must be able to produce it. */
export const SERVER_EMBEDDING_DIMENSIONS = 1536;

export const LLM_PROVIDERS = ["google", "openai", "anthropic", "openai-compatible"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export const EMBEDDING_PROVIDERS = ["google", "openai", "openai-compatible"] as const;
export type EmbeddingProvider = (typeof EMBEDDING_PROVIDERS)[number];

export interface ProviderInfo {
  id: LlmProvider;
  label: string;
  /** Suggested model ids; any model the provider serves works. */
  llmModels: string[];
  embeddingModels: string[];
  /** The caller must give the provider's address. */
  needsBaseUrl: boolean;
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: "google",
    label: "Google Gemini",
    llmModels: ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-3.5-flash"],
    embeddingModels: ["gemini-embedding-001"],
    needsBaseUrl: false,
  },
  {
    id: "openai",
    label: "OpenAI",
    llmModels: ["gpt-5-mini", "gpt-5"],
    embeddingModels: ["text-embedding-3-small", "text-embedding-3-large"],
    needsBaseUrl: false,
  },
  {
    id: "anthropic",
    label: "Anthropic",
    llmModels: ["claude-haiku-5-5", "claude-sonnet-5-5"],
    embeddingModels: [],
    needsBaseUrl: false,
  },
  {
    id: "openai-compatible",
    label: "OpenAI-compatible",
    llmModels: [],
    embeddingModels: [],
    needsBaseUrl: true,
  },
];

export interface LlmConfig {
  provider: LlmProvider;
  model: string;
  apiKey: string;
  baseUrl?: string;
}

export interface EmbeddingConfig {
  provider: EmbeddingProvider;
  model: string;
  apiKey: string;
  baseUrl?: string;
}
