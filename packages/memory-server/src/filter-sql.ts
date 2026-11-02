import { memories, memoryTerms } from "@memdot/db";
import { type FilterNode, tokenize } from "@memdot/memory-engine";
import { and, not, or, type SQL, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { AssistedKeys } from "./keys.js";

const COLUMNS: Record<string, PgColumn> = {
  user_id: memories.userId,
  agent_id: memories.agentId,
  run_id: memories.runId,
};
const UUID_COLUMNS: Record<string, PgColumn> = {
  memory_ids: memories.id,
  source_object_id: memories.sourceObjectId,
};
const DATE_COLUMNS: Record<string, PgColumn> = {
  created_at: memories.createdAt,
  updated_at: memories.updatedAt,
  expiration_date: memories.expiresAt,
};

type Condition = Extract<FilterNode, { type: "condition" }>;

const comparison = (left: SQL, op: string, right: unknown): SQL | undefined => {
  switch (op) {
    case "eq":
      return sql`${left} = ${right}`;
    case "ne":
      return sql`${left} is distinct from ${right}`;
    case "gt":
      return sql`${left} > ${right}`;
    case "gte":
      return sql`${left} >= ${right}`;
    case "lt":
      return sql`${left} < ${right}`;
    case "lte":
      return sql`${left} <= ${right}`;
    default:
      return undefined;
  }
};

function textCondition(column: SQL, node: Condition): SQL {
  const value = node.value;
  switch (node.op) {
    case "exists":
      return sql`${column} is not null`;
    case "in":
      return sql`${column} = any(${toTextArray(value as unknown[])})`;
    case "nin":
      return sql`${column} is null or not (${column} = any(${toTextArray(value as unknown[])}))`;
    case "contains":
      return sql`position(${String(value)} in ${column}) > 0`;
    case "icontains":
      return sql`position(lower(${String(value)}) in lower(${column})) > 0`;
    default:
      return comparison(column, node.op, String(value)) as SQL;
  }
}

const toTextArray = (values: unknown[]) =>
  sql`array[${sql.join(
    values.map((value) => sql`${String(value)}`),
    sql`, `,
  )}]::text[]`;

function dateCondition(column: PgColumn, node: Condition): SQL {
  const at = (value: unknown) => new Date(String(value)).toISOString();
  switch (node.op) {
    case "exists":
      return sql`${column} is not null`;
    case "in":
    case "nin": {
      const list = sql`array[${sql.join(
        (node.value as unknown[]).map((value) => sql`${at(value)}::timestamptz`),
        sql`, `,
      )}]`;
      return node.op === "in"
        ? sql`${column} = any(${list})`
        : sql`${column} is null or not (${column} = any(${list}))`;
    }
    default: {
      const built = comparison(sql`${column}`, node.op, sql`${at(node.value)}::timestamptz`);
      if (!built) throw new Error(`"${node.op}" doesn't apply to dates.`);
      return built;
    }
  }
}

function categoryCondition(node: Condition): SQL {
  const lowered = sql`(select array_agg(lower(c)) from unnest(${memories.categories}) c)`;
  switch (node.op) {
    case "exists":
      return sql`coalesce(cardinality(${memories.categories}), 0) > 0`;
    case "in":
      return sql`${lowered} && ${toTextArray((node.value as unknown[]).map((v) => String(v).toLowerCase()))}`;
    case "nin":
      return sql`not coalesce(${lowered} && ${toTextArray((node.value as unknown[]).map((v) => String(v).toLowerCase()))}, false)`;
    case "ne":
      return sql`not coalesce(${String(node.value).toLowerCase()} = any(${lowered}), false)`;
    default:
      return sql`${String(node.value).toLowerCase()} = any(${lowered})`;
  }
}

function metadataCondition(node: Condition): SQL {
  const value = sql`(${memories.metadata} ->> ${node.path as string})`;
  // Numbers compare as numbers when both sides are numeric; anything else compares as text.
  const numeric = typeof node.value === "number" || /^-?\d+(\.\d+)?$/.test(String(node.value));
  if (["gt", "gte", "lt", "lte"].includes(node.op) && numeric) {
    const number = sql`(case when ${value} ~ '^-?[0-9]+(\\.[0-9]+)?$' then ${value}::numeric end)`;
    return comparison(number, node.op, sql`${Number(node.value)}::numeric`) as SQL;
  }
  return textCondition(value, node);
}

function keywordCondition(keys: AssistedKeys, folderId: string, node: Condition): SQL {
  const terms = [...new Set(tokenize(String(node.value)))];
  if (terms.length === 0) return sql`true`;
  return and(
    ...terms.map(
      (term) =>
        sql`exists (select 1 from ${memoryTerms} t where t.memory_id = ${memories.id} and t.term = ${keys.blindTerm(folderId, term)})`,
    ),
  ) as SQL;
}

function nodeToSql(keys: AssistedKeys, folderId: string, node: FilterNode): SQL {
  switch (node.type) {
    case "and":
      return and(...node.children.map((child) => filterToSql(keys, folderId, child))) as SQL;
    case "or":
      return or(...node.children.map((child) => filterToSql(keys, folderId, child))) as SQL;
    case "not":
      return not(or(...node.children.map((child) => filterToSql(keys, folderId, child))) as SQL);
    case "condition": {
      if (node.field === "keywords") return keywordCondition(keys, folderId, node);
      if (node.field === "categories") return categoryCondition(node);
      if (node.field === "metadata") return metadataCondition(node);
      const uuid = UUID_COLUMNS[node.field];
      if (uuid) return textCondition(sql`${uuid}::text`, node);
      const date = DATE_COLUMNS[node.field];
      if (date) return dateCondition(date, node);
      return textCondition(sql`${COLUMNS[node.field] as PgColumn}`, node);
    }
  }
}

/**
 * A parsed filter as SQL over `memories`. Values are always bound, never spliced. Every node comes
 * back in its own parentheses: the result is ANDed with the namespace check, and a bare `or` inside
 * it would reach past that check into other accounts' rows.
 */
export function filterToSql(keys: AssistedKeys, folderId: string, node: FilterNode): SQL {
  return sql`(${nodeToSql(keys, folderId, node)})`;
}
