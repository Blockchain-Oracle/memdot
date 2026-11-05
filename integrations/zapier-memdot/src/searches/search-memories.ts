import {
  defineInputFields,
  defineSearch,
  type InferInputData,
  type SearchPerform,
} from "zapier-platform-core";
import { DEFAULT_TOP_K, MAX_RESULTS } from "../constants.js";
import {
  memoryOutput,
  memorySample,
  namespaceField,
  scopeFields,
  scopeFilters,
} from "../fields.js";

const inputFields = defineInputFields([
  {
    key: "query",
    label: "Query",
    type: "string",
    required: true,
    helpText: "What to look for, in plain words.",
  },
  ...scopeFields,
  ...namespaceField,
  {
    key: "top_k",
    label: "How Many",
    type: "integer",
    default: String(DEFAULT_TOP_K),
    helpText: `Up to ${MAX_RESULTS}. Zapier uses the first one in later steps.`,
  },
]);

const perform = (async (z, bundle) => {
  const { query, top_k, namespace_id } = bundle.inputData;
  const response = await z.request({
    method: "POST",
    url: "/v1/memories/search",
    body: {
      query,
      top_k: Math.min(Number(top_k) || DEFAULT_TOP_K, MAX_RESULTS),
      ...scopeFilters(bundle.inputData),
      ...(namespace_id ? { namespace_id } : {}),
    },
  });
  return (response.data as { results: (typeof memorySample & { score: number })[] }).results;
}) satisfies SearchPerform<InferInputData<typeof inputFields>>;

export default defineSearch({
  key: "search_memories",
  noun: "Memory",
  display: {
    label: "Search Memories",
    description: "Finds what's been remembered, by meaning and keyword.",
  },
  operation: {
    perform,
    inputFields,
    sample: { ...memorySample, score: 0.75 },
    outputFields: [...memoryOutput, { key: "score", label: "Score", type: "number" }],
  },
});
