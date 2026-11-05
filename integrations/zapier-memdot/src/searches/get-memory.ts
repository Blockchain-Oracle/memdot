import {
  defineInputFields,
  defineSearch,
  type InferInputData,
  type SearchPerform,
} from "zapier-platform-core";
import { memoryOutput, memorySample } from "../fields.js";

const inputFields = defineInputFields([
  { key: "id", label: "Memory ID", type: "string", required: true },
]);

const perform = (async (z, bundle) => {
  const response = await z.request({
    url: `/v1/memories/${encodeURIComponent(bundle.inputData.id)}`,
    skipThrowForStatus: true,
  });
  // A search that finds nothing is an empty list, so a Zap can take its "not found" path.
  return response.status === 404 ? [] : [response.data as typeof memorySample];
}) satisfies SearchPerform<InferInputData<typeof inputFields>>;

export default defineSearch({
  key: "get_memory",
  noun: "Memory",
  display: { label: "Find Memory by ID", description: "Reads one memory." },
  operation: { perform, inputFields, sample: memorySample, outputFields: memoryOutput },
});
