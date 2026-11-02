"""The filter language for search and list, run on your machine for Private namespaces."""

from __future__ import annotations

import math
import re
from datetime import datetime, timezone
from typing import Any

from .tokenize import term_frequencies

FILTER_FIELDS = (
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
)
FILTER_OPERATORS = (
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
)
_LOGICAL = {"AND": "and", "OR": "or", "NOT": "not"}
_LIST_OPERATORS = {"in", "nin"}
_MAX_DEPTH = 8
_MAX_CONDITIONS = 64
_MAX_LIST = 256


class FilterError(ValueError):
    """A filter that says what to change."""


def _conditions_for(field: str, value: Any, path: str | None = None) -> list[dict[str, Any]]:
    at = {"path": path} if path else {}
    if value == "*":
        return [{"type": "condition", "field": field, **at, "op": "exists", "value": True}]
    if not isinstance(value, dict):
        return [{"type": "condition", "field": field, **at, "op": "eq", "value": value}]
    nodes = []
    for op, operand in value.items():
        if op not in FILTER_OPERATORS or op == "exists":
            allowed = ", ".join(FILTER_OPERATORS[:-1])
            raise FilterError(
                f'Unknown filter operator "{op}". Use one of: {allowed}, or "*" for any value.'
            )
        if op in _LIST_OPERATORS:
            if not isinstance(operand, list):
                raise FilterError(f'The "{op}" operator takes a list.')
            if len(operand) > _MAX_LIST:
                raise FilterError(f'The "{op}" operator takes up to {_MAX_LIST} values.')
        nodes.append({"type": "condition", "field": field, **at, "op": op, "value": operand})
    return nodes


def parse_filter(raw: Any) -> dict[str, Any]:
    """Parses a filter object, or raises a FilterError that says what to change."""
    return _parse_node(raw, 1, {"conditions": 0})


def _parse_node(raw: Any, depth: int, budget: dict[str, int]) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise FilterError("A filter must be an object.")
    if depth > _MAX_DEPTH:
        raise FilterError(f"A filter can nest {_MAX_DEPTH} levels deep.")

    def counted(nodes: list[dict[str, Any]]) -> list[dict[str, Any]]:
        budget["conditions"] += len(nodes)
        if budget["conditions"] > _MAX_CONDITIONS:
            raise FilterError(f"A filter can hold {_MAX_CONDITIONS} conditions.")
        return nodes

    children: list[dict[str, Any]] = []
    for key, value in raw.items():
        logical = _LOGICAL.get(key)
        if logical:
            # NOT takes one condition or a list; a list means "none of these".
            items = value if isinstance(value, list) else ([value] if logical == "not" else None)
            if not items:
                raise FilterError(f"{key} takes a non-empty list of conditions.")
            children.append(
                {
                    "type": logical,
                    "children": [_parse_node(item, depth + 1, budget) for item in items],
                }
            )
        elif key == "metadata":
            if not isinstance(value, dict):
                raise FilterError("metadata takes an object of keys.")
            for path, condition in value.items():
                children.extend(counted(_conditions_for("metadata", condition, path)))
        elif key.startswith("metadata."):
            children.extend(counted(_conditions_for("metadata", value, key[len("metadata.") :])))
        elif key in FILTER_FIELDS:
            children.extend(counted(_conditions_for(key, value)))
        else:
            fields = ", ".join(FILTER_FIELDS)
            raise FilterError(f'Can\'t filter on "{key}". Use AND, OR, NOT, {fields} or metadata.')
    return children[0] if len(children) == 1 else {"type": "and", "children": children}


_DATE_FIELDS = {"created_at", "updated_at", "expiration_date"}
_FRACTION = re.compile(r"\.(\d+)")


def parse_instant(value: Any) -> float:
    """Seconds since the epoch, or NaN for anything that isn't a date, as JavaScript does."""
    text = str(value).strip()
    if text.endswith(("Z", "z")):
        text = f"{text[:-1]}+00:00"
    text = _FRACTION.sub(lambda m: f".{m.group(1)[:6].ljust(6, '0')}", text)
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return math.nan
    if parsed.tzinfo is None:
        # A bare date is UTC in JavaScript; a date with a time and no zone is local.
        parsed = parsed.replace(tzinfo=timezone.utc) if "T" not in text else parsed.astimezone()
    return parsed.timestamp()


def _number(value: Any) -> float:
    """What JavaScript's `Number` gives, for the kinds of value a filter holds."""
    if value is None or value is False:
        return 0.0
    if value is True:
        return 1.0
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return 0.0
        try:
            return float(text)
        except ValueError:
            return math.nan
    return math.nan


def _text(value: Any) -> str:
    """What JavaScript's `String` gives."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _compare(left: Any, right: Any, dates: bool) -> float:
    """Dates compare as instants, numbers as numbers, and anything else as text."""
    if dates:
        return parse_instant(left) - parse_instant(right)
    a, b = _number(left), _number(right)
    if math.isfinite(a) and math.isfinite(b):
        return a - b
    x, y = _text(left), _text(right)
    return (x > y) - (x < y)


def _field_value(memory: dict[str, Any], node: dict[str, Any]) -> Any:
    field = node["field"]
    if field == "metadata":
        return (memory.get("metadata") or {}).get(node["path"])
    return memory.get(
        {
            "user_id": "userId",
            "agent_id": "agentId",
            "run_id": "runId",
            "created_at": "createdAt",
            "updated_at": "updatedAt",
            "expiration_date": "expiresAt",
            "categories": "categories",
            "memory_ids": "id",
            "keywords": "text",
            "source_object_id": "sourceObjectId",
        }[field]
    )


def _matches_condition(memory: dict[str, Any], node: dict[str, Any]) -> bool:
    value = _field_value(memory, node)
    missing = value is None
    op = node["op"]
    operand = node["value"]
    if op == "exists":
        return not missing
    if node["field"] == "keywords":
        haystack = term_frequencies(_text(value) if value is not None else "")
        return all(term in haystack for term in term_frequencies(_text(operand)))
    if isinstance(value, list):
        # A list field (categories): any overlap counts, in any case.
        items = [_text(item).lower() for item in value]

        def has(item: Any) -> bool:
            return _text(item).lower() in items

        if op in ("eq", "contains", "icontains"):
            return has(operand)
        if op == "ne":
            return not has(operand)
        if op == "in":
            return any(has(item) for item in operand)
        if op == "nin":
            return not any(has(item) for item in operand)
        return False
    dates = node["field"] in _DATE_FIELDS
    if op == "eq":
        return not missing and _compare(value, operand, dates) == 0
    if op == "ne":
        return missing or _compare(value, operand, dates) != 0
    if op == "in":
        return not missing and any(_compare(value, item, dates) == 0 for item in operand)
    if op == "nin":
        return missing or not any(_compare(value, item, dates) == 0 for item in operand)
    if op == "gt":
        return not missing and _compare(value, operand, dates) > 0
    if op == "gte":
        return not missing and _compare(value, operand, dates) >= 0
    if op == "lt":
        return not missing and _compare(value, operand, dates) < 0
    if op == "lte":
        return not missing and _compare(value, operand, dates) <= 0
    if op == "contains":
        return not missing and _text(operand) in _text(value)
    if op == "icontains":
        return not missing and _text(operand).lower() in _text(value).lower()
    return False


def matches_filter(memory: dict[str, Any], node: dict[str, Any]) -> bool:
    kind = node["type"]
    if kind == "and":
        return all(matches_filter(memory, child) for child in node["children"])
    if kind == "or":
        return any(matches_filter(memory, child) for child in node["children"])
    if kind == "not":
        return not any(matches_filter(memory, child) for child in node["children"])
    return _matches_condition(memory, node)


def is_expired(expires_at: str | None, at: datetime) -> bool:
    """A memory is gone from search and lists once its expiry date has passed."""
    if not expires_at:
        return False
    instant = parse_instant(expires_at)
    return math.isfinite(instant) and instant < at.timestamp()
