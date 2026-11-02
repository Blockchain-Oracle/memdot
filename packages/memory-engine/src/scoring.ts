import { tokenize } from "./tokenize.js";

/** The most keyword matches can lift a memory, as a share of what semantic similarity left. */
const KEYWORD_WEIGHT = 0.5;
/** The most a named entity in the query can lift a memory. */
export const ENTITY_BOOST = 0.5;
/** Words in a query combined when looking for named entities ("new york city"). */
const MAX_ENTITY_WORDS = 3;

/** How many candidates each signal fetches for a result list of `limit`. */
export const candidateCount = (limit: number) => Math.max(limit * 4, 60);

/** Longer queries score higher raw BM25, so the curve that squeezes it to 0..1 moves with them. */
function bm25Curve(terms: number): { midpoint: number; steepness: number } {
  if (terms <= 3) return { midpoint: 5, steepness: 0.7 };
  if (terms <= 6) return { midpoint: 7, steepness: 0.6 };
  if (terms <= 9) return { midpoint: 9, steepness: 0.5 };
  if (terms <= 15) return { midpoint: 10, steepness: 0.5 };
  return { midpoint: 12, steepness: 0.5 };
}

export function normalizeBm25(raw: number, queryTerms: number): number {
  if (raw <= 0) return 0;
  const { midpoint, steepness } = bm25Curve(queryTerms);
  return 1 / (1 + Math.exp(-steepness * (raw - midpoint)));
}

export interface ScoreBreakdown {
  semantic: number;
  bm25: number;
  entity: number;
}

/**
 * Semantic similarity is the base; keywords and named entities can only lift it toward 1. They
 * never pull a good semantic match down because some other memory happened to match a keyword.
 */
export function combineScores({ semantic, bm25, entity }: ScoreBreakdown): number {
  const base = Math.max(semantic, 0);
  const lift = Math.min(1, KEYWORD_WEIGHT * bm25 + entity);
  return Math.min(1, base + (1 - base) * lift);
}

export interface Candidate {
  id: string;
  /** Cosine similarity; null when the memory has no vector yet. */
  semantic: number | null;
  /** Raw BM25. */
  keyword: number;
  entity: number;
}

export interface RankOptions {
  queryTerms: number;
  limit: number;
  /** Minimum semantic similarity, applied before anything lifts a memory. */
  threshold: number;
  mode: "hybrid" | "semantic" | "keyword";
}

export interface Ranked extends ScoreBreakdown {
  id: string;
  score: number;
}

/** Merges each signal's candidates into the final order. */
export function rank(candidates: Candidate[], options: RankOptions): Ranked[] {
  const ranked: Ranked[] = [];
  for (const candidate of candidates) {
    const semantic = candidate.semantic ?? 0;
    const bm25 = normalizeBm25(candidate.keyword, options.queryTerms);
    if (options.mode === "keyword") {
      if (candidate.keyword > 0) {
        ranked.push({ id: candidate.id, semantic, bm25, entity: 0, score: bm25 });
      }
      continue;
    }
    // A memory without a vector can still be found by its words; the threshold has nothing to gate.
    if (candidate.semantic === null ? candidate.keyword <= 0 : semantic < options.threshold) {
      continue;
    }
    const parts =
      options.mode === "semantic"
        ? { semantic, bm25: 0, entity: 0 }
        : { semantic, bm25, entity: candidate.entity };
    ranked.push({ id: candidate.id, ...parts, score: combineScores(parts) });
  }
  return ranked.sort((a, b) => b.score - a.score).slice(0, options.limit);
}

/** Lowercased, single-spaced: how entity names compare. */
export const normalizeEntity = (name: string) =>
  name.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

/** Every run of up to three words in a query, to spot entity names it mentions. */
export function entityCandidates(query: string): string[] {
  const words = normalizeEntity(query).match(/[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu) ?? [];
  const found = new Set<string>();
  for (let start = 0; start < words.length; start += 1) {
    for (let size = 1; size <= MAX_ENTITY_WORDS && start + size <= words.length; size += 1) {
      found.add(words.slice(start, start + size).join(" "));
    }
  }
  return [...found];
}

/** Number of searchable terms in a query. */
export const queryTermCount = (query: string) => new Set(tokenize(query)).size;
