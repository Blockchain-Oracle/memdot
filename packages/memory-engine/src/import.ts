/** One memory as read from an export file, in whatever spelling that file used. */
export interface ImportItem {
  text: string;
  userId?: string;
  agentId?: string;
  runId?: string;
  metadata?: Record<string, unknown>;
  categories?: string[];
  createdAt?: string;
  updatedAt?: string;
  expiresAt?: string;
}

export interface ParsedImport {
  items: ImportItem[];
  /** Rows with no text anywhere, so nothing to import. */
  skipped: number;
}

type Row = Record<string, unknown>;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

/** The first of these fields holding text. Different exports name it differently. */
function firstText(row: Row, keys: string[]): string | undefined {
  for (const key of keys) {
    const found = text(row[key]);
    if (found) return found;
  }
  return undefined;
}

const TEXT_FIELDS = ["memory", "text", "content", "new_memory"];

function bodyOf(row: Row): string | undefined {
  const direct = firstText(row, TEXT_FIELDS);
  if (direct) return direct;
  const data = row.data;
  return (
    text(data) ??
    (data && typeof data === "object" ? firstText(data as Row, TEXT_FIELDS) : undefined)
  );
}

/** A date that parses, as ISO. Exports hold ISO strings, YYYY-MM-DD dates or epoch seconds. */
function date(value: unknown): string | undefined {
  if (typeof value === "number") return new Date(value * 1000).toISOString();
  if (typeof value !== "string") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function itemOf(row: unknown): ImportItem | null {
  if (typeof row === "string") return row.trim() ? { text: row } : null;
  if (!row || typeof row !== "object") return null;
  const fields = row as Row;
  const body = bodyOf(fields);
  if (!body) return null;
  const item: ImportItem = { text: body };
  const userId = firstText(fields, ["user_id", "userId"]);
  const agentId = firstText(fields, ["agent_id", "agentId"]);
  const runId = firstText(fields, ["run_id", "runId", "session_id"]);
  if (userId) item.userId = userId;
  if (agentId) item.agentId = agentId;
  if (runId) item.runId = runId;
  if (fields.metadata && typeof fields.metadata === "object") {
    item.metadata = fields.metadata as Record<string, unknown>;
  }
  if (Array.isArray(fields.categories)) {
    item.categories = fields.categories.filter((c): c is string => typeof c === "string");
  }
  const createdAt = date(fields.created_at ?? fields.createdAt);
  const updatedAt = date(fields.updated_at ?? fields.updatedAt);
  const expiresAt = date(fields.expiration_date ?? fields.expiresAt);
  if (createdAt) item.createdAt = createdAt;
  if (updatedAt) item.updatedAt = updatedAt;
  if (expiresAt) item.expiresAt = expiresAt;
  return item;
}

/** Every array of rows in a MemDot export: `{spaces:[{namespaces:[{memories:[…]}]}]}`. */
function rowsOf(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (!json || typeof json !== "object") return [json];
  const envelope = json as Row;
  if (Array.isArray(envelope.results)) return envelope.results;
  if (Array.isArray(envelope.memories)) return envelope.memories;
  if (Array.isArray(envelope.spaces)) {
    return envelope.spaces.flatMap(
      (space) =>
        ((space as Row).namespaces as Row[] | undefined)?.flatMap(
          (namespace) => (namespace.memories as unknown[] | undefined) ?? [],
        ) ?? [],
    );
  }
  return [json];
}

/**
 * Reads memories from an export: MemDot's own file, or a list or `{results: […]}` page from another
 * memory product, with the text under `memory`, `text`, `content` or `data`.
 */
export function parseMemoryImport(json: unknown): ParsedImport {
  const rows = rowsOf(json);
  const items = rows.flatMap((row) => {
    const item = itemOf(row);
    return item ? [item] : [];
  });
  return { items, skipped: rows.length - items.length };
}
