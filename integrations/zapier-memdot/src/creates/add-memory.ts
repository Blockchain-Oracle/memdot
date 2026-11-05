import {
  type CreatePerform,
  defineCreate,
  defineInputFields,
  type InferInputData,
  type ZObject,
} from "zapier-platform-core";
import { INDEX_WAIT_MS, POLL_MS } from "../constants.js";
import { isYes, namespaceField, scopeBody, scopeFields } from "../fields.js";

const inputFields = defineInputFields([
  {
    key: "text",
    label: "Text",
    type: "text",
    required: true,
    helpText: "What to remember: a fact, an email, a whole conversation.",
  },
  ...scopeFields,
  ...namespaceField,
  {
    key: "infer",
    label: "Distill With a Model",
    type: "boolean",
    default: "true",
    helpText:
      "Yes keeps the facts a model finds in the text. No keeps the text exactly as written.",
  },
  {
    key: "metadata",
    label: "Metadata",
    type: "text",
    helpText: 'Anything to keep with it, as JSON. For example {"source":"gmail"}.',
  },
]);

interface MemoryEvent {
  id: string;
  status: string;
  indexed: boolean;
  results: { id: string; memory: string | null; event: string }[];
  duplicates: number;
  note: string | null;
  error: string | null;
  tx_hash: string | null;
  block: number | null;
}

/**
 * Zapier gives a step 30 seconds, and reaching the chain can take longer than that. So this waits
 * only until the memory can be searched, and says how far it got. The rest carries on in MemDot.
 */
async function untilSearchable(z: ZObject, eventId: string): Promise<MemoryEvent | null> {
  const deadline = Date.now() + INDEX_WAIT_MS;
  let event: MemoryEvent | null = null;
  while (Date.now() < deadline) {
    const response = await z.request({ url: `/v1/memories/events/${eventId}` });
    event = response.data as MemoryEvent;
    if (event.status === "FAILED") {
      throw new z.errors.Error(event.error ?? "The write failed.", "MemoryFailed", 422);
    }
    if (event.status === "SUCCEEDED" || event.indexed) return event;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  return event;
}

const perform = (async (z, bundle) => {
  const { text, infer, metadata, namespace_id } = bundle.inputData;
  const scope = scopeBody(bundle.inputData);
  if (Object.keys(scope).length === 0) {
    throw new z.errors.Error(
      "Give at least one of User ID, Agent ID or Run ID, so the memory has someone to belong to.",
      "ScopeRequired",
      400,
    );
  }
  if (Object.values(scope).includes("*")) {
    throw new z.errors.Error(
      "\"*\" means everyone in a filter, so it can't be someone's ID.",
      "BadScope",
      400,
    );
  }
  let parsedMetadata: unknown;
  if (metadata) {
    try {
      parsedMetadata = JSON.parse(String(metadata));
    } catch {
      throw new z.errors.Error("Metadata isn't valid JSON.", "BadMetadata", 400);
    }
  }
  const accepted = await z.request({
    method: "POST",
    url: "/v1/memories",
    body: {
      messages: [{ role: "user", content: text }],
      infer: isYes(infer, true),
      ...scope,
      ...(namespace_id ? { namespace_id } : {}),
      ...(parsedMetadata ? { metadata: parsedMetadata } : {}),
    },
  });
  const {
    event_id,
    namespace_id: namespace,
    status,
  } = accepted.data as {
    event_id: string;
    namespace_id: string;
    status: string;
  };
  const event = await untilSearchable(z, event_id);
  return {
    id: event_id,
    event_id,
    namespace_id: namespace,
    status: event?.status ?? status,
    searchable: event?.indexed ?? false,
    memories: event?.results ?? [],
    memory_count: event?.results.length ?? 0,
    duplicates: event?.duplicates ?? 0,
    note: event?.note ?? null,
    tx_hash: event?.tx_hash ?? null,
    block: event?.block ?? null,
  };
}) satisfies CreatePerform<InferInputData<typeof inputFields>>;

export default defineCreate({
  key: "add_memory",
  noun: "Memory",
  display: {
    label: "Add Memory",
    description: "Remembers something, encrypted and stored on Portaldot V3.",
  },
  operation: {
    perform,
    inputFields,
    sample: {
      id: "5994cc98-ca04-4fe4-9124-1ceef163f065",
      event_id: "5994cc98-ca04-4fe4-9124-1ceef163f065",
      namespace_id: "4b84e666-4133-4066-9675-298b200f3b3a",
      status: "RUNNING",
      searchable: true,
      memories: [
        {
          id: "7d45e792-1ae3-4a12-8ef0-2cd0fba93b65",
          memory: "Alex deploys on Fridays, never on Mondays",
          event: "ADD",
        },
      ],
      memory_count: 1,
      duplicates: 0,
      note: null,
      tx_hash: null,
      block: null,
    },
    outputFields: [
      { key: "event_id", label: "Event ID" },
      { key: "status", label: "Status" },
      { key: "searchable", label: "Searchable Now", type: "boolean" },
      { key: "memory_count", label: "Memories Saved", type: "integer" },
      { key: "duplicates", label: "Already Known", type: "integer" },
      { key: "note", label: "Note" },
      { key: "tx_hash", label: "Transaction" },
      { key: "block", label: "Block", type: "integer" },
    ],
  },
});
