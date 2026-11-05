import { defineInputFields } from "zapier-platform-core";

export const memorySample = {
  id: "7d45e792-1ae3-4a12-8ef0-2cd0fba93b65",
  memory: "Alex deploys on Fridays, never on Mondays",
  user_id: "alex",
  agent_id: null,
  run_id: null,
  categories: null,
  metadata: null,
  namespace_id: "4b84e666-4133-4066-9675-298b200f3b3a",
  created_at: "2026-11-03T14:08:37.032Z",
  updated_at: "2026-11-03T14:08:37.032Z",
};

export const memoryOutput = [
  { key: "id", label: "Memory ID", primary: true },
  { key: "memory", label: "Memory" },
  { key: "user_id", label: "User ID" },
  { key: "agent_id", label: "Agent ID" },
  { key: "run_id", label: "Run ID" },
  { key: "namespace_id", label: "Namespace ID" },
  { key: "created_at", label: "Created", type: "datetime" as const },
  { key: "updated_at", label: "Updated", type: "datetime" as const },
];

export const scopeFields = defineInputFields([
  {
    key: "user_id",
    label: "User ID",
    type: "string",
    helpText: "Who this is about, in whatever IDs you already use.",
  },
  { key: "agent_id", label: "Agent ID", type: "string", helpText: "Which agent this belongs to." },
  {
    key: "run_id",
    label: "Run ID",
    type: "string",
    helpText: "Which session or run this belongs to.",
  },
]);

export const namespaceField = defineInputFields([
  {
    key: "namespace_id",
    label: "Namespace",
    type: "string",
    dynamic: "list_namespaces.id.label",
    helpText: "Where memories live. Blank uses your default namespace.",
  },
]);

type Scope = {
  user_id?: string | undefined;
  agent_id?: string | undefined;
  run_id?: string | undefined;
};

export const scopeBody = ({ user_id, agent_id, run_id }: Scope) => ({
  ...(user_id ? { user_id } : {}),
  ...(agent_id ? { agent_id } : {}),
  ...(run_id ? { run_id } : {}),
});

/** `{ AND: [...] }`, or nothing when no ID is given. */
export function scopeFilters(scope: Scope): { filters?: { AND: Record<string, string>[] } } {
  const parts = Object.entries(scopeBody(scope)).map(([key, value]) => ({ [key]: value }));
  return parts.length ? { filters: { AND: parts } } : {};
}
