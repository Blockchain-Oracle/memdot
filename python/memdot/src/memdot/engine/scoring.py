"""How memories are ranked: semantic similarity is the base, and the rest can only lift it."""

from __future__ import annotations

import math
import re
import unicodedata
from typing import Any

from .tokenize import JS_SPACE, tokenize

_KEYWORD_WEIGHT = 0.5
#: The most a named entity in the query can lift a memory.
ENTITY_BOOST = 0.5
_MAX_ENTITY_WORDS = 3
_RUNS = re.compile(f"[{JS_SPACE}]+")
_ENDS = re.compile(f"^[{JS_SPACE}]+|[{JS_SPACE}]+$")
_ENTITY_WORD = re.compile(r"[^\W_][\w'\-]*")


def candidate_count(limit: int) -> int:
    """How many candidates each signal fetches for a result list of `limit`."""
    return max(limit * 4, 60)


def _bm25_curve(terms: int) -> tuple[float, float]:
    """Longer queries score higher raw BM25, so the curve moves with them."""
    if terms <= 3:
        return 5, 0.7
    if terms <= 6:
        return 7, 0.6
    if terms <= 9:
        return 9, 0.5
    if terms <= 15:
        return 10, 0.5
    return 12, 0.5


def normalize_bm25(raw: float, query_terms: int) -> float:
    if raw <= 0:
        return 0
    midpoint, steepness = _bm25_curve(query_terms)
    return 1 / (1 + math.exp(-steepness * (raw - midpoint)))


def combine_scores(semantic: float, bm25: float, entity: float) -> float:
    base = max(semantic, 0)
    lift = min(1, _KEYWORD_WEIGHT * bm25 + entity)
    return min(1, base + (1 - base) * lift)


def rank(
    candidates: list[dict[str, Any]],
    *,
    query_terms: int,
    limit: int,
    threshold: float,
    mode: str,
) -> list[dict[str, Any]]:
    """Merges each signal's candidates into the final order."""
    ranked: list[dict[str, Any]] = []
    for candidate in candidates:
        semantic = candidate["semantic"] if candidate["semantic"] is not None else 0
        bm25 = normalize_bm25(candidate["keyword"], query_terms)
        if mode == "keyword":
            if candidate["keyword"] > 0:
                ranked.append(
                    {
                        "id": candidate["id"],
                        "semantic": semantic,
                        "bm25": bm25,
                        "entity": 0,
                        "score": bm25,
                    }
                )
            continue
        # A memory without a vector can still be found by its words.
        if candidate["semantic"] is None:
            if candidate["keyword"] <= 0:
                continue
        elif semantic < threshold:
            continue
        if mode == "semantic":
            bm25_part, entity = 0, 0
        else:
            bm25_part, entity = bm25, candidate["entity"]
        ranked.append(
            {
                "id": candidate["id"],
                "semantic": semantic,
                "bm25": bm25_part,
                "entity": entity,
                "score": combine_scores(semantic, bm25_part, entity),
            }
        )
    ranked.sort(key=lambda hit: -hit["score"])
    return ranked[:limit]


def normalize_entity(name: str) -> str:
    """Lowercased, single-spaced: how entity names compare."""
    normalized = unicodedata.normalize("NFKC", name)
    return _RUNS.sub(" ", _ENDS.sub("", normalized)).lower()


def entity_candidates(query: str) -> list[str]:
    """Every run of up to three words in a query, to spot entity names it mentions."""
    words = _ENTITY_WORD.findall(normalize_entity(query))
    found: dict[str, None] = {}
    for start in range(len(words)):
        for size in range(1, _MAX_ENTITY_WORDS + 1):
            if start + size > len(words):
                break
            found[" ".join(words[start : start + size])] = None
    return list(found)


def query_term_count(query: str) -> int:
    return len(set(tokenize(query)))
