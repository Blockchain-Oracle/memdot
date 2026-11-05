export { dot, type Embedder, LOCAL_EMBEDDING_MODEL, unitLength } from "./embedder.js";
export {
  decodeEntry,
  dedupeKey,
  encodeEntry,
  type MemoryChange,
  type MemoryEntry,
  type MemoryEvent,
  type MemorySource,
  normalizeText,
} from "./entry.js";
export {
  FILTER_FIELDS,
  FILTER_OPERATORS,
  type FilterableMemory,
  FilterError,
  type FilterField,
  type FilterNode,
  type FilterOperator,
  isExpired,
  matchesFilter,
  parseFilter,
} from "./filters.js";
export {
  buildGraph,
  type GraphEdge,
  type GraphMemory,
  type GraphNode,
  type MemoryGraph,
  type MemoryRelation,
} from "./graph.js";
export { type ImportItem, type ParsedImport, parseMemoryImport } from "./import.js";
export { LocalIndex, readSnapshot, type SnapshotHeader } from "./local-index.js";
export {
  type ChatMessage,
  type ContentPart,
  hasAttachments,
  messageText,
  normalizeMessages,
} from "./messages.js";
export {
  AGENT_SCOPE_SUFFIX,
  COPILOT_SYSTEM,
  DEFAULT_CATEGORIES,
  EXTRACTION_SYSTEM,
  INSTRUCTIONS_SYSTEM,
  PROCEDURAL_SYSTEM,
  type PromptCategory,
  RECALL_PREAMBLE,
  RERANK_SYSTEM,
  SUMMARY_SYSTEM,
} from "./prompts.js";
export {
  EMBEDDING_PROVIDERS,
  type EmbeddingConfig,
  type EmbeddingProvider,
  LLM_PROVIDERS,
  type LlmConfig,
  type LlmProvider,
  PROVIDERS,
  type ProviderInfo,
  SERVER_EMBEDDING_DIMENSIONS,
} from "./providers.js";
export {
  applyDecay,
  type Candidate,
  candidateCount,
  combineScores,
  DECAY_OVERFETCH,
  decayFactor,
  ENTITY_BOOST,
  entityCandidates,
  normalizeBm25,
  normalizeEntity,
  queryTermCount,
  type Ranked,
  type RankOptions,
  rank,
  type ScoreBreakdown,
} from "./scoring.js";
export { STOPWORDS, termFrequencies, tokenize } from "./tokenize.js";
