import { EMBEDDING_PROVIDERS, LLM_PROVIDERS } from "@memdot/memory-engine";
import { z } from "zod";

/** Provider keys and the secret Assisted namespaces derive from. The API and the worker share them. */
export const memoryEnvSchema = z.object({
  /** Every Assisted key derives from this. Changing it makes server-side copies unreadable. */
  MEMORY_SECRET: z.string().min(32),
  /** The model an account uses until it sets its own. Unset: bring your own, or infer stays off. */
  MEMORY_LLM_PROVIDER: z.enum(LLM_PROVIDERS).optional(),
  MEMORY_LLM_MODEL: z.string().optional(),
  MEMORY_LLM_API_KEY: z.string().optional(),
  MEMORY_LLM_BASE_URL: z.url().optional(),
  MEMORY_EMBEDDING_PROVIDER: z.enum(EMBEDDING_PROVIDERS).optional(),
  MEMORY_EMBEDDING_MODEL: z.string().optional(),
  MEMORY_EMBEDDING_API_KEY: z.string().optional(),
  MEMORY_EMBEDDING_BASE_URL: z.url().optional(),
  /** Model calls per account per day on MemDot's own key; your own key has no limit. */
  MEMORY_DAILY_SHARED_WRITES: z.coerce.number().int().positive().default(100),
  /** Searches embedded per account per day on MemDot's own key; past it, search is by keyword. */
  MEMORY_DAILY_SHARED_SEARCHES: z.coerce.number().int().positive().default(1_000),
});
export type MemoryEnv = z.infer<typeof memoryEnvSchema>;
