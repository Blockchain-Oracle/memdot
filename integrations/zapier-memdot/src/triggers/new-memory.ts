import {
  defineInputFields,
  defineTrigger,
  type InferInputData,
  type PollingTriggerPerform,
} from "zapier-platform-core";
import { NEW_MEMORY_PAGE, SAMPLE_PAGE } from "../constants.js";
import {
  memoryOutput,
  memorySample,
  namespaceField,
  scopeFields,
  scopeFilters,
} from "../fields.js";

// Unlike an action, a trigger's settings are chosen once and don't come from an earlier step, so
// leaving the IDs empty here can only mean what it says: every new memory in the namespace.
const inputFields = defineInputFields([...scopeFields, ...namespaceField]);

const perform = (async (z, bundle) => {
  const { namespace_id } = bundle.inputData;
  const response = await z.request({
    method: "POST",
    url: "/v1/memories/list",
    body: {
      page_size: bundle.meta?.isLoadingSample ? SAMPLE_PAGE : NEW_MEMORY_PAGE,
      ...scopeFilters(bundle.inputData),
      ...(namespace_id ? { namespace_id } : {}),
    },
  });
  // Newest first, which is the order Zapier needs to tell new from old by ID.
  return (response.data as { results: (typeof memorySample)[] }).results;
}) satisfies PollingTriggerPerform<InferInputData<typeof inputFields>>;

export default defineTrigger({
  key: "new_memory",
  noun: "Memory",
  display: {
    label: "New Memory",
    description: "Triggers when something new is remembered.",
  },
  operation: {
    type: "polling",
    perform,
    inputFields,
    sample: memorySample,
    outputFields: memoryOutput,
  },
});
