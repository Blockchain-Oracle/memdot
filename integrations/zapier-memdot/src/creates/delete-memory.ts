import {
  type CreatePerform,
  defineCreate,
  defineInputFields,
  type InferInputData,
} from "zapier-platform-core";

const inputFields = defineInputFields([
  { key: "id", label: "Memory ID", type: "string", required: true },
]);

const perform = (async (z, bundle) => {
  await z.request({
    method: "DELETE",
    url: `/v1/memories/${encodeURIComponent(bundle.inputData.id)}`,
  });
  return { id: bundle.inputData.id, deleted: true };
}) satisfies CreatePerform<InferInputData<typeof inputFields>>;

export default defineCreate({
  key: "delete_memory",
  noun: "Memory",
  display: {
    label: "Delete Memory",
    description: "Forgets a memory: out of search at once. This can't be undone.",
  },
  operation: {
    perform,
    inputFields,
    sample: { id: "7d45e792-1ae3-4a12-8ef0-2cd0fba93b65", deleted: true },
    outputFields: [
      { key: "id", label: "Memory ID" },
      { key: "deleted", label: "Deleted", type: "boolean" },
    ],
  },
});
