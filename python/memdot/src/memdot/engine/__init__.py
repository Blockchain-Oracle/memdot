"""The parts of memory that run on your machine: search, filters, entries and prompts."""

from __future__ import annotations

import json
import re
import unicodedata
from datetime import datetime, timezone
from hashlib import blake2b
from importlib import resources
from typing import Any

from ..crypto import dumps
from .filters import FilterError, is_expired, matches_filter, parse_filter
from .imports import parse_memory_import
from .local_index import LocalIndex, read_snapshot
from .scoring import (
    ENTITY_BOOST,
    candidate_count,
    combine_scores,
    entity_candidates,
    normalize_bm25,
    normalize_entity,
    query_term_count,
    rank,
)
from .tokenize import JS_SPACE, term_frequencies, tokenize

__all__ = [
    "ENTITY_BOOST",
    "PROMPTS",
    "FilterError",
    "LocalIndex",
    "candidate_count",
    "combine_scores",
    "decode_entry",
    "dedupe_key",
    "encode_entry",
    "entity_candidates",
    "has_attachments",
    "is_expired",
    "iso_now",
    "matches_filter",
    "message_text",
    "normalize_bm25",
    "normalize_entity",
    "normalize_messages",
    "normalize_text",
    "parse_filter",
    "parse_memory_import",
    "query_term_count",
    "rank",
    "read_snapshot",
    "term_frequencies",
    "to_filterable",
    "tokenize",
]

#: One text in both languages; a test checks this file against the TypeScript prompts.
PROMPTS: dict[str, Any] = json.loads(
    resources.files("memdot.engine").joinpath("prompts.json").read_text("utf8")
)

LOCAL_EMBEDDING_MODEL = {"id": "Xenova/all-MiniLM-L6-v2", "dtype": "q8", "dimensions": 384}

_RUNS = re.compile(f"[{JS_SPACE}]+")
_ENDS = re.compile(f"^[{JS_SPACE}]+|[{JS_SPACE}]+$")


def encode_entry(entry: dict[str, Any]) -> bytes:
    return dumps(entry)


def decode_entry(data: bytes) -> dict[str, Any]:
    entry = json.loads(data)
    if (
        entry.get("v") != 1
        or not isinstance(entry.get("id"), str)
        or not isinstance(entry.get("text"), str)
        or not isinstance(entry.get("version"), int)
        or not isinstance(entry.get("createdAt"), str)
        or not isinstance(entry.get("updatedAt"), str)
    ):
        raise ValueError("not a MemDot memory entry")
    return entry


def normalize_text(text: str) -> str:
    """A memory's text reduced so that trivial differences count as the same fact."""
    normalized = unicodedata.normalize("NFKC", text)
    return _RUNS.sub(" ", _ENDS.sub("", normalized)).lower()


def dedupe_key(text: str, scope: dict[str, Any]) -> str:
    """Same scope, same fact: the second add is dropped. Hashed, so it names no content."""
    material = "\0".join(
        [
            scope.get("userId") or "",
            scope.get("agentId") or "",
            scope.get("runId") or "",
            normalize_text(text),
        ]
    )
    return blake2b(material.encode(), digest_size=16).hexdigest()


def to_filterable(entry: dict[str, Any]) -> dict[str, Any]:
    source = entry.get("source") or {}
    return {
        "id": entry["id"],
        "text": entry["text"],
        "userId": entry.get("userId"),
        "agentId": entry.get("agentId"),
        "runId": entry.get("runId"),
        "createdAt": entry["createdAt"],
        "updatedAt": entry["updatedAt"],
        "expiresAt": entry.get("expiresAt"),
        "categories": entry.get("categories"),
        "metadata": entry.get("metadata"),
        "sourceObjectId": source.get("objectId"),
    }


def normalize_messages(messages: Any) -> list[dict[str, Any]]:
    """Messages may be a bare string; the caller meant one user turn."""
    if isinstance(messages, str):
        return [{"role": "user", "content": messages}]
    return list(messages) if isinstance(messages, list) else [messages]


def message_text(message: dict[str, Any]) -> str:
    """A message's text alone, for embedding or storing as written."""
    content = message["content"]
    if isinstance(content, str):
        return content
    return " ".join(part["text"] for part in content if part.get("type") == "text")


def has_attachments(messages: list[dict[str, Any]]) -> bool:
    return any(
        not isinstance(message["content"], str)
        and any(part.get("type") != "text" for part in message["content"])
        for message in messages
    )


def iso_now() -> str:
    """Now, written the way JavaScript's `toISOString` writes it."""
    now = datetime.now(timezone.utc)
    return f"{now.strftime('%Y-%m-%dT%H:%M:%S')}.{now.microsecond // 1000:03d}Z"
