import {
  type CreatePerform,
  defineCreate,
  defineInputFields,
  type InferInputData,
} from "zapier-platform-core";
import { memoryOutput, memorySample } from "../fields.js";

const inputFields = defineInputFields([
  { key: "id", label: "Memory ID", type: "string", required: true },
  { key: "text", label: "Text", type: "text", required: true, helpText: "What it should say now." },
]);

const perform = (async (z, bundle) => {
  const response = await z.request({
    method: "PUT",
    url: `/v1/memories/${encodeURIComponent(bundle.inputData.id)}`,
    body: { text: bundle.inputData.text },
  });
  return response.data as typeof memorySample;
}) satisfies CreatePerform<InferInputData<typeof inputFields>>;

export default defineCreate({
  key: "update_memory",
  noun: "Memory",
  display: {
    label: "Update Memory",
    description: "Corrects a memory. The old version stays in its history.",
  },
  operation: { perform, inputFields, sample: memorySample, outputFields: memoryOutput },
});
