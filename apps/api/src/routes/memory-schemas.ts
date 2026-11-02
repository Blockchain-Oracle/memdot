import { z } from "@hono/zod-openapi";
import { FILTER_OPERATORS } from "@memdot/memory-engine";
import { ChatMessageSchema } from "@memdot/memory-engine/llm";

// Memory routes use the snake_case field names agent tooling already knows (user_id, top_k, …).

export const ScopeId = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^\S+$/, "Scope ids can't contain spaces.");

/** YYYY-MM-DD or a full timestamp. A date-only expiry lasts through that whole day, UTC. */
export const ExpirationDate = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), "Expected a date, YYYY-MM-DD.")
  .openapi({ example: "2027-01-31" });

export const Filters = z.record(z.string(), z.unknown()).openapi({
  description: `Conditions on user_id, agent_id, run_id, created_at, updated_at, expiration_date, categories, memory_ids, keywords and metadata, combined with AND, OR and NOT to any depth; sibling keys mean AND. Operators: ${FILTER_OPERATORS.slice(0, -1).join(", ")}; "*" means any value.`,
  example: { AND: [{ user_id: "alice" }, { created_at: { gte: "2026-10-01" } }] },
});

const SourceRef = z.object({
  kind: z.enum(["conversation", "file", "manual", "import"]),
  object_id: z.uuid().nullable(),
  label: z.string().nullable(),
});

export const Memory = z
  .object({
    id: z.uuid(),
    memory: z.string().openapi({ description: "The memory's text, opened for this response" }),
    namespace_id: z.uuid(),
    user_id: z.string().nullable(),
    agent_id: z.string().nullable(),
    run_id: z.string().nullable(),
    metadata: z.record(z.string(), z.unknown()).nullable(),
    categories: z.array(z.string()).nullable(),
    memory_type: z.string().nullable(),
    attributed_to: z.string().nullable(),
    source: SourceRef.nullable(),
    raw: z.boolean().openapi({ description: "Extraction failed, so this is the text as written" }),
    immutable: z.boolean(),
    version: z.number().int(),
    feedback: z.string().nullable(),
    expiration_date: z.string().nullable(),
    occurred_at: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
    segment: z
      .object({
        id: z.uuid(),
        cid: z.string(),
        status: z.string(),
        block: z.number().int().nullable(),
      })
      .nullable()
      .openapi({ description: "Where it's stored on V3. Null while it's being written." }),
  })
  .openapi("Memory");

export const ScoredMemory = Memory.extend({
  score: z.number(),
  score_breakdown: z.object({ semantic: z.number(), bm25: z.number(), entity: z.number() }),
  rerank_score: z.number().optional(),
}).openapi("ScoredMemory");

export const MemoryPage = z
  .object({
    results: z.array(Memory),
    count: z.number().int().openapi({ description: "Matching memories, across every page" }),
    next_cursor: z.string().nullable(),
  })
  .openapi("MemoryPage");

export const EventStatus = z.enum(["PENDING", "RUNNING", "SUCCEEDED", "FAILED"]);

export const AddAccepted = z
  .object({
    event_id: z
      .uuid()
      .openapi({ description: "Poll /v1/memories/events/{id}, or follow it as a job" }),
    status: EventStatus,
    namespace_id: z.uuid(),
  })
  .openapi("MemoryAddAccepted");

export const AddRequest = z
  .object({
    messages: z.union([z.string().min(1), z.array(ChatMessageSchema).min(1)]).openapi({
      description:
        "A string, or chat messages. Content may include image_url, pdf_url, txt_url and mdx_url parts.",
    }),
    namespace_id: z.uuid().optional().openapi({
      description: "The memory namespace. Defaults to this key's oldest Assisted namespace.",
    }),
    user_id: ScopeId.optional(),
    agent_id: ScopeId.optional(),
    run_id: ScopeId.optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    expiration_date: ExpirationDate.nullable().optional(),
    timestamp: z.union([z.number().int(), z.string()]).optional().openapi({
      description: "When this happened: epoch seconds or ISO. Relative dates count from it.",
    }),
    infer: z.boolean().default(true).openapi({
      description: "true: a model distills facts. false: each message is stored as written.",
    }),
    memory_type: z.literal("procedural_memory").optional().openapi({
      description: "An agent's working record, stored as one memory. Needs agent_id.",
    }),
    prompt: z.string().max(8_000).optional().openapi({
      description: "Custom instructions for this call, over the namespace's own",
    }),
    custom_categories: z
      .array(z.record(z.string(), z.string()))
      .optional()
      .openapi({ description: "Categories for this call: [{name: description}]" }),
    immutable: z.boolean().optional(),
    source: z
      .object({ object_id: z.uuid().optional(), label: z.string().max(128).optional() })
      .optional()
      .openapi({
        description: "The file this was read from. Deleting the file deletes these memories.",
      }),
  })
  .openapi("MemoryAddRequest");

export const SearchRequest = z
  .object({
    query: z.string().trim().min(1).max(8_000),
    namespace_id: z.uuid().optional(),
    filters: Filters.optional(),
    top_k: z.number().int().min(1).max(1_000).default(10),
    threshold: z.number().min(0).max(1).default(0.1).openapi({
      description: "Minimum semantic similarity. 0 turns it off.",
    }),
    mode: z.enum(["hybrid", "semantic", "keyword"]).default("hybrid"),
    keyword_search: z.boolean().optional().openapi({ description: "Same as mode: keyword" }),
    rerank: z.boolean().default(false).openapi({ description: "Reorder results with the model." }),
    show_expired: z.boolean().default(false),
    reference_date: z.union([z.number().int(), z.string()]).optional().openapi({
      description: "Search as of this moment: later memories and later expiries are out of view.",
    }),
  })
  .openapi("MemorySearchRequest");

export const ListRequest = z
  .object({
    namespace_id: z.uuid().optional(),
    filters: Filters.optional(),
    show_expired: z.boolean().default(false),
    cursor: z.string().optional(),
    page_size: z.number().int().min(1).max(200).default(50),
  })
  .openapi("MemoryListRequest");

export const UpdateRequest = z
  .object({
    text: z.string().trim().min(1).max(64_000).optional(),
    metadata: z.record(z.string(), z.unknown()).optional().openapi({
      description: "Merged over the existing metadata",
    }),
    expiration_date: ExpirationDate.nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, "Give at least one field to change.")
  .openapi("MemoryUpdateRequest");

export const HistoryEntry = z
  .object({
    id: z.number().int(),
    memory_id: z.uuid(),
    old_memory: z.string().nullable(),
    new_memory: z.string().nullable(),
    event: z.enum(["ADD", "UPDATE", "DELETE"]),
    actor: z.string().nullable(),
    version: z.number().int(),
    created_at: z.string(),
  })
  .openapi("MemoryHistoryEntry");

export const MemoryEventRow = z
  .object({
    id: z.uuid(),
    event_type: z.string().openapi({ example: "ADD" }),
    status: EventStatus,
    results: z.array(z.object({ id: z.uuid(), memory: z.string().nullable(), event: z.string() })),
    duplicates: z.number().int(),
    indexed: z
      .boolean()
      .openapi({ description: "Searchable now, even if still reaching the chain" }),
    note: z.string().nullable(),
    error: z.string().nullable(),
    tx_hash: z.string().nullable(),
    block: z.number().int().nullable(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .openapi("MemoryEvent");

export const Entity = z
  .object({
    id: z.string(),
    type: z.enum(["user", "agent", "run"]),
    total_memories: z.number().int(),
    created_at: z.string(),
    updated_at: z.string(),
    namespace_id: z.uuid(),
  })
  .openapi("Entity");

export const NamespaceRow = z
  .object({
    id: z.uuid(),
    space_id: z.uuid(),
    encrypted_name: z.string(),
    mode: z.enum(["private", "assisted"]),
    key_epoch: z.number().int(),
    total_memories: z.number().int(),
    segments: z.number().int(),
    last_write: z.string().nullable(),
    created_at: z.string(),
  })
  .openapi("Namespace");

export const CategoryDefinition = z.object({
  name: z.string().min(1).max(64),
  description: z.string().max(400).optional(),
});

export const NamespaceSettings = z
  .object({
    custom_instructions: z.string().max(8_000).nullable(),
    categories: z.array(CategoryDefinition).nullable(),
    /** Private namespaces: the same settings, sealed on the device. */
    sealed: z.string().nullable(),
  })
  .openapi("NamespaceSettings");
