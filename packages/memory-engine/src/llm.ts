// The parts that call a model. Separate from the main entry so that pages which never extract
// anything don't load the AI SDK and its providers.

export type { ModelMessage } from "ai";
export {
  type CopilotData,
  type CopilotStream,
  copilotTools,
  streamCopilot,
} from "./copilot.js";
export {
  ChatMessageSchema,
  type DreamProposal,
  type ExtractedMemory,
  type ExtractInput,
  exportToSchema,
  extractMemories,
  type FetchDocument,
  generateInstructions,
  generateProfile,
  proceduralRecord,
  proposeDream,
  rerankTexts,
  summarizeMemories,
  type UserProfile,
} from "./extract.js";
export { languageModel, providerEmbedder } from "./models.js";
