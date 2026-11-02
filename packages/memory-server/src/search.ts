import { type Database, memories, memoryTerms } from "@memdot/db";
import {
  type Candidate,
  candidateCount,
  type Embedder,
  ENTITY_BOOST,
  entityCandidates,
  type FilterNode,
  normalizeEntity,
  queryTermCount,
  type Ranked,
  rank,
  tokenize,
} from "@memdot/memory-engine";
import { and, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import { filterToSql } from "./filter-sql.js";
import type { AssistedKeys } from "./keys.js";

const BM25_K1 = 1.2;
const BM25_B = 0.75;
/** Graph candidates pgvector looks at; more than the default for better recall under filters. */
const HNSW_EF_SEARCH = 100;

export interface SearchInput {
  folderId: string;
  query: string;
  limit: number;
  threshold: number;
  mode: "hybrid" | "semantic" | "keyword";
  filter?: FilterNode | undefined;
  /** Hide what expired before this moment, and what hadn't happened yet. */
  at: Date;
  showExpired: boolean;
  asOf?: Date | undefined;
  embedder: Embedder | null;
}

/** Live memories in a namespace matching a filter, not expired. Shared by search and lists. */
export function scopeOf(
  keys: AssistedKeys,
  input: Pick<SearchInput, "folderId" | "filter" | "at" | "showExpired" | "asOf">,
): SQL {
  return and(
    eq(memories.folderId, input.folderId),
    isNull(memories.deletedAt),
    input.showExpired
      ? undefined
      : sql`(${memories.expiresAt} is null or ${memories.expiresAt} >= ${input.at.toISOString()}::timestamptz)`,
    input.asOf
      ? sql`coalesce(${memories.occurredAt}, ${memories.createdAt}) <= ${input.asOf.toISOString()}::timestamptz`
      : undefined,
    input.filter ? filterToSql(keys, input.folderId, input.filter) : undefined,
  ) as SQL;
}

async function semanticHits(
  db: Pick<Database, "transaction">,
  scope: SQL,
  vector: number[],
  modelId: string,
  limit: number,
): Promise<Map<string, number>> {
  const literal = `[${vector.join(",")}]`;
  // Filtering happens after the graph walk, so keep walking until enough rows match (pgvector 0.8).
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`set local hnsw.ef_search = ${HNSW_EF_SEARCH}`));
    await tx.execute(sql`set local hnsw.iterative_scan = strict_order`);
    const rows = await tx
      .select({
        id: memories.id,
        score: sql<number>`1 - (${memories.embedding} <=> ${literal}::vector)`,
      })
      .from(memories)
      .where(and(scope, eq(memories.embeddingModel, modelId)))
      .orderBy(sql`${memories.embedding} <=> ${literal}::vector`)
      .limit(limit);
    return new Map(rows.map((row) => [row.id, Number(row.score)]));
  });
}

/** Okapi BM25 over blinded terms: the server ranks by words it can't read. */
async function keywordHits(
  db: Pick<Database, "execute">,
  scope: SQL,
  folderId: string,
  blindedTerms: string[],
  limit: number,
): Promise<Map<string, number>> {
  if (blindedTerms.length === 0) return new Map();
  const list = sql.join(
    blindedTerms.map((term) => sql`${term}`),
    sql`, `,
  );
  const result = await db.execute<{ id: string; score: string }>(sql`
    with stats as (
      select count(*)::float8 as n, greatest(avg(term_count), 1)::float8 as average
        from memories where folder_id = ${folderId} and deleted_at is null
    ), df as (
      select term, count(*)::float8 as df from ${memoryTerms}
       where folder_id = ${folderId} and term in (${list}) group by term
    )
    select ${memories.id} as id,
           sum(
             ln(1 + (stats.n - df.df + 0.5) / (df.df + 0.5))
             * (t.count * (${BM25_K1}::float8 + 1))
             / (t.count + ${BM25_K1}::float8 * (1 - ${BM25_B}::float8 + ${BM25_B}::float8 * ${memories.termCount} / stats.average))
           ) as score
      from ${memoryTerms} t
      join df on df.term = t.term
      join ${memories} on ${memories.id} = t.memory_id
      cross join stats
     where t.folder_id = ${folderId} and ${scope}
     group by ${memories.id}
     order by score desc
     limit ${limit}`);
  return new Map(result.rows.map((row) => [row.id, Number(row.score)]));
}

/** Runs semantic and keyword search and merges them, best first. */
export async function searchMemories(
  db: Database,
  keys: AssistedKeys,
  input: SearchInput,
): Promise<Ranked[]> {
  const scope = scopeOf(keys, input);
  const fetch = candidateCount(input.limit);
  const terms = [...new Set(tokenize(input.query))].map((term) =>
    keys.blindTerm(input.folderId, term),
  );

  const wantsVectors = input.mode !== "keyword" && input.embedder !== null;
  // A provider that's down or over quota leaves keyword search standing.
  const queryVector = wantsVectors
    ? await (input.embedder as Embedder).embed([input.query], "query").then(
        (vectors) => vectors[0],
        (error: unknown) => {
          console.warn("[memory] query embedding failed:", error);
          return undefined;
        },
      )
    : undefined;
  const semantic = queryVector
    ? await semanticHits(db, scope, queryVector, (input.embedder as Embedder).modelId, fetch)
    : new Map<string, number>();
  const keyword =
    input.mode === "semantic"
      ? new Map<string, number>()
      : await keywordHits(db, scope, input.folderId, terms, fetch);

  // A keyword hit outside the nearest neighbours still needs its similarity.
  const missing = [...keyword.keys()].filter((id) => !semantic.has(id));
  if (queryVector && missing.length > 0) {
    const literal = `[${queryVector.join(",")}]`;
    const rows = await db
      .select({
        id: memories.id,
        score: sql<number | null>`1 - (${memories.embedding} <=> ${literal}::vector)`,
      })
      .from(memories)
      .where(
        and(
          inArray(memories.id, missing),
          eq(memories.embeddingModel, (input.embedder as Embedder).modelId),
        ),
      );
    for (const row of rows) if (row.score !== null) semantic.set(row.id, Number(row.score));
  }

  const ids = [...new Set([...semantic.keys(), ...keyword.keys()])];
  const entityNames = entityCandidates(input.query).map((name) =>
    keys.blindTerm(input.folderId, `entity:${normalizeEntity(name)}`),
  );
  const named =
    ids.length && entityNames.length
      ? await db
          .select({ id: memories.id, entityTerms: memories.entityTerms })
          .from(memories)
          .where(inArray(memories.id, ids))
      : [];
  const wanted = new Set(entityNames);
  const entityBoost = new Map(
    named.map((row) => [
      row.id,
      row.entityTerms?.some((term) => wanted.has(term)) ? ENTITY_BOOST : 0,
    ]),
  );

  const candidates: Candidate[] = ids.map((id) => ({
    id,
    semantic: semantic.get(id) ?? null,
    keyword: keyword.get(id) ?? 0,
    entity: entityBoost.get(id) ?? 0,
  }));
  return rank(candidates, {
    queryTerms: queryTermCount(input.query),
    limit: input.limit,
    threshold: input.threshold,
    mode: input.mode,
  });
}
