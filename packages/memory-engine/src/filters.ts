import { termFrequencies } from "./tokenize.js";

/**
 * The filter language for search and list: conditions on scopes, dates, categories and metadata,
 * combined with AND, OR and NOT to any depth. Sibling keys mean AND. One parser and two backends:
 * SQL on the server for Assisted namespaces, `matchesFilter` on the device for Private ones.
 */
export const FILTER_FIELDS = [
  "user_id",
  "agent_id",
  "run_id",
  "created_at",
  "updated_at",
  "expiration_date",
  "categories",
  "memory_ids",
  "keywords",
  "source_object_id",
] as const;
export type FilterField = (typeof FILTER_FIELDS)[number] | "metadata";

export const FILTER_OPERATORS = [
  "eq",
  "ne",
  "in",
  "nin",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "icontains",
  "exists",
] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export type FilterNode =
  | { type: "and" | "or" | "not"; children: FilterNode[] }
  | {
      type: "condition";
      field: FilterField;
      /** Key inside metadata, when the field is metadata. */
      path?: string;
      op: FilterOperator;
      value: unknown;
    };

export class FilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilterError";
  }
}

const LOGICAL: Record<string, "and" | "or" | "not"> = { AND: "and", OR: "or", NOT: "not" };
const LIST_OPERATORS = new Set<FilterOperator>(["in", "nin"]);
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function conditionsFor(field: FilterField, value: unknown, path?: string): FilterNode[] {
  const at = path ? { path } : {};
  if (value === "*") return [{ type: "condition", field, ...at, op: "exists", value: true }];
  if (!isPlainObject(value)) {
    return [{ type: "condition", field, ...at, op: "eq", value }];
  }
  return Object.entries(value).map(([op, operand]) => {
    if (!FILTER_OPERATORS.includes(op as FilterOperator) || op === "exists") {
      throw new FilterError(
        `Unknown filter operator "${op}". Use one of: ${FILTER_OPERATORS.slice(0, -1).join(", ")}, or "*" for any value.`,
      );
    }
    if (LIST_OPERATORS.has(op as FilterOperator) && !Array.isArray(operand)) {
      throw new FilterError(`The "${op}" operator takes a list.`);
    }
    return { type: "condition", field, ...at, op: op as FilterOperator, value: operand };
  });
}

/** Parses a filter object, or throws a FilterError that says what to change. */
export function parseFilter(raw: unknown): FilterNode {
  if (!isPlainObject(raw)) throw new FilterError("A filter must be an object.");
  const children: FilterNode[] = [];
  for (const [key, value] of Object.entries(raw)) {
    const logical = LOGICAL[key];
    if (logical) {
      // NOT takes one condition or a list; a list means "none of these".
      const items = Array.isArray(value) ? value : logical === "not" ? [value] : null;
      if (!items || items.length === 0) {
        throw new FilterError(`${key} takes a non-empty list of conditions.`);
      }
      children.push({ type: logical, children: items.map(parseFilter) });
    } else if (key === "metadata") {
      if (!isPlainObject(value)) throw new FilterError("metadata takes an object of keys.");
      for (const [path, condition] of Object.entries(value)) {
        children.push(...conditionsFor("metadata", condition, path));
      }
    } else if (key.startsWith("metadata.")) {
      children.push(...conditionsFor("metadata", value, key.slice("metadata.".length)));
    } else if (FILTER_FIELDS.includes(key as (typeof FILTER_FIELDS)[number])) {
      children.push(...conditionsFor(key as FilterField, value));
    } else {
      throw new FilterError(
        `Can't filter on "${key}". Use AND, OR, NOT, ${FILTER_FIELDS.join(", ")} or metadata.`,
      );
    }
  }
  if (children.length === 1) return children[0] as FilterNode;
  return { type: "and", children };
}

/** What the on-device evaluator can see of a memory. */
export interface FilterableMemory {
  id: string;
  text: string;
  userId?: string | null | undefined;
  agentId?: string | null | undefined;
  runId?: string | null | undefined;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string | null | undefined;
  categories?: string[] | null | undefined;
  metadata?: Record<string, unknown> | null | undefined;
  sourceObjectId?: string | null | undefined;
}

const isDateField = (field: FilterField) =>
  field === "created_at" || field === "updated_at" || field === "expiration_date";

/** Dates compare as instants, numbers as numbers, and anything else as text. */
function compare(left: unknown, right: unknown, dates: boolean): number {
  if (dates) return Date.parse(String(left)) - Date.parse(String(right));
  const a = Number(left);
  const b = Number(right);
  if (Number.isFinite(a) && Number.isFinite(b)) return a - b;
  return String(left).localeCompare(String(right));
}

function fieldValue(memory: FilterableMemory, node: FilterNode & { type: "condition" }): unknown {
  switch (node.field) {
    case "user_id":
      return memory.userId;
    case "agent_id":
      return memory.agentId;
    case "run_id":
      return memory.runId;
    case "created_at":
      return memory.createdAt;
    case "updated_at":
      return memory.updatedAt;
    case "expiration_date":
      return memory.expiresAt;
    case "categories":
      return memory.categories;
    case "memory_ids":
      return memory.id;
    case "keywords":
      return memory.text;
    case "source_object_id":
      return memory.sourceObjectId;
    case "metadata":
      return memory.metadata?.[node.path as string];
  }
}

function matchesCondition(
  memory: FilterableMemory,
  node: FilterNode & { type: "condition" },
): boolean {
  const value = fieldValue(memory, node);
  const missing = value === undefined || value === null;
  if (node.op === "exists") return !missing;
  if (node.field === "keywords") {
    const haystack = termFrequencies(String(value ?? ""));
    return [...termFrequencies(String(node.value))].every(([term]) => haystack.has(term));
  }
  if (Array.isArray(value)) {
    // A list field (categories): any overlap counts, in any case.
    const items = value.map((item) => String(item).toLowerCase());
    const has = (item: unknown) => items.includes(String(item).toLowerCase());
    switch (node.op) {
      case "eq":
      case "contains":
      case "icontains":
        return has(node.value);
      case "ne":
        return !has(node.value);
      case "in":
        return (node.value as unknown[]).some(has);
      case "nin":
        return !(node.value as unknown[]).some(has);
      default:
        return false;
    }
  }
  const dates = isDateField(node.field);
  switch (node.op) {
    case "eq":
      return !missing && compare(value, node.value, dates) === 0;
    case "ne":
      return missing || compare(value, node.value, dates) !== 0;
    case "in":
      return !missing && (node.value as unknown[]).some((v) => compare(value, v, dates) === 0);
    case "nin":
      return missing || !(node.value as unknown[]).some((v) => compare(value, v, dates) === 0);
    case "gt":
      return !missing && compare(value, node.value, dates) > 0;
    case "gte":
      return !missing && compare(value, node.value, dates) >= 0;
    case "lt":
      return !missing && compare(value, node.value, dates) < 0;
    case "lte":
      return !missing && compare(value, node.value, dates) <= 0;
    case "contains":
      return !missing && String(value).includes(String(node.value));
    case "icontains":
      return !missing && String(value).toLowerCase().includes(String(node.value).toLowerCase());
  }
}

export function matchesFilter(memory: FilterableMemory, node: FilterNode): boolean {
  switch (node.type) {
    case "and":
      return node.children.every((child) => matchesFilter(memory, child));
    case "or":
      return node.children.some((child) => matchesFilter(memory, child));
    case "not":
      return !node.children.some((child) => matchesFilter(memory, child));
    case "condition":
      return matchesCondition(memory, node);
  }
}

/**
 * A memory is gone from search and lists once its expiry date has passed: visible through that
 * day, hidden from the next. Nothing is deleted, and asking for it by id still works.
 */
export function isExpired(expiresAt: string | Date | null | undefined, at: Date): boolean {
  if (!expiresAt) return false;
  const time = new Date(expiresAt).getTime();
  return Number.isFinite(time) && time < at.getTime();
}
