import { defineTrigger, type PollingTriggerPerform } from "zapier-platform-core";
import { ID_CHARS } from "../constants.js";

interface Namespace {
  id: string;
  mode: "private" | "assisted";
  total_memories: number;
}

const perform = (async (z) => {
  const response = await z.request({ url: "/v1/namespaces" });
  // Names are sealed to your own devices, so this is what there is to go by. A Private one can't be
  // read from here at all, so it isn't offered.
  return (response.data as { results: Namespace[] }).results
    .filter((namespace) => namespace.mode === "assisted")
    .map((namespace) => ({
      id: namespace.id,
      label: `Assisted ${namespace.id.slice(0, ID_CHARS)} (${namespace.total_memories} memories)`,
    }));
}) satisfies PollingTriggerPerform;

export default defineTrigger({
  key: "list_namespaces",
  noun: "Namespace",
  display: {
    label: "List Namespaces",
    description: "Fills the namespace dropdown.",
    hidden: true,
  },
  operation: {
    type: "polling",
    perform,
    sample: {
      id: "4b84e666-4133-4066-9675-298b200f3b3a",
      label: "Assisted 4b84e666 (12 memories)",
    },
    outputFields: [
      { key: "id", label: "Namespace ID" },
      { key: "label", label: "Label" },
    ],
  },
});
