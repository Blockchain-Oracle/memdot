"""Reading memories from an export, in whatever spelling that file used."""

from __future__ import annotations

import math
from datetime import datetime, timezone
from typing import Any

from .filters import parse_instant

_TEXT_FIELDS = ("memory", "text", "content", "new_memory")


def _text(value: Any) -> str | None:
    return value if isinstance(value, str) and value.strip() else None


def _first_text(row: dict[str, Any], keys: tuple[str, ...]) -> str | None:
    for key in keys:
        found = _text(row.get(key))
        if found:
            return found
    return None


def _body_of(row: dict[str, Any]) -> str | None:
    direct = _first_text(row, _TEXT_FIELDS)
    if direct:
        return direct
    data = row.get("data")
    return _text(data) or (_first_text(data, _TEXT_FIELDS) if isinstance(data, dict) else None)


def _iso(seconds: float) -> str:
    moment = datetime.fromtimestamp(seconds, timezone.utc)
    return f"{moment.strftime('%Y-%m-%dT%H:%M:%S')}.{moment.microsecond // 1000:03d}Z"


def _date(value: Any) -> str | None:
    """A date that parses, as ISO. Exports hold ISO strings, dates or epoch seconds."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return _iso(float(value))
    if not isinstance(value, str):
        return None
    instant = parse_instant(value)
    return None if math.isnan(instant) else _iso(instant)


def _item_of(row: Any) -> dict[str, Any] | None:
    if isinstance(row, str):
        return {"text": row} if row.strip() else None
    if not isinstance(row, dict):
        return None
    body = _body_of(row)
    if not body:
        return None
    item: dict[str, Any] = {"text": body}
    user_id = _first_text(row, ("user_id", "userId"))
    agent_id = _first_text(row, ("agent_id", "agentId"))
    run_id = _first_text(row, ("run_id", "runId", "session_id"))
    if user_id:
        item["userId"] = user_id
    if agent_id:
        item["agentId"] = agent_id
    if run_id:
        item["runId"] = run_id
    if isinstance(row.get("metadata"), dict):
        item["metadata"] = row["metadata"]
    if isinstance(row.get("categories"), list):
        item["categories"] = [c for c in row["categories"] if isinstance(c, str)]
    created = _date(row.get("created_at") or row.get("createdAt"))
    updated = _date(row.get("updated_at") or row.get("updatedAt"))
    expires = _date(row.get("expiration_date") or row.get("expiresAt"))
    if created:
        item["createdAt"] = created
    if updated:
        item["updatedAt"] = updated
    if expires:
        item["expiresAt"] = expires
    return item


def _rows_of(data: Any) -> list[Any]:
    if isinstance(data, list):
        return data
    if not isinstance(data, dict):
        return [data]
    if isinstance(data.get("results"), list):
        return data["results"]
    if isinstance(data.get("memories"), list):
        return data["memories"]
    if isinstance(data.get("spaces"), list):
        return [
            memory
            for space in data["spaces"]
            for namespace in (space.get("namespaces") or [])
            for memory in (namespace.get("memories") or [])
        ]
    return [data]


def parse_memory_import(data: Any) -> dict[str, Any]:
    """Reads memories from MemDot's own file, or a list or `{results: […]}` from another product."""
    rows = _rows_of(data)
    items = [item for item in map(_item_of, rows) if item]
    return {"items": items, "skipped": len(rows) - len(items)}
