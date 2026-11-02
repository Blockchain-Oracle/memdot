"""Long-term memory for LangGraph and LangChain, on Portaldot V3.

    from langgraph.graph import StateGraph
    from memdot import MemDot
    from memdot.integrations.langgraph import MemDotStore

    store = MemDotStore(MemDot.from_credentials())
    graph = builder.compile(store=store)
    store.put(("memories", "alex"), "deploys", {"text": "Alex deploys on Fridays"})
    store.search(("memories", "alex"), query="when does Alex deploy?")

A store is key-addressed and MemDot gives memories their own ids, so the namespace and key travel in
the memory's metadata. Memories are stored as written, never through a model. `MemDotStore` embeds on
MemDot's side or this machine's, so an `index` config is accepted and ignored.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Iterable, Mapping
from datetime import datetime, timezone
from typing import Any

from ..models import Memory, ScoredMemory
from . import missing

try:
    from langchain_core.tools import StructuredTool
    from langgraph.store.base import (
        BaseStore,
        GetOp,
        Item,
        ListNamespacesOp,
        MatchCondition,
        Op,
        PutOp,
        Result,
        SearchItem,
        SearchOp,
    )
except ImportError as error:
    missing("langgraph", error)

_NAMESPACE = "store_namespace"
_KEY = "store_key"
_VALUE = "store_value"
_SEPARATOR = "/"
_TEXT_FIELDS = ("text", "content", "memory")
_PAGE = 100
#: Search asks for more than it returns, since a namespace prefix and a filter are applied here.
_SEARCH_OVERFETCH = 4
_MAX_FETCH = 100


def _text_of(value: Mapping[str, Any]) -> str:
    for field in _TEXT_FIELDS:
        if isinstance(value.get(field), str) and value[field].strip():
            return value[field]
    return json.dumps(value, ensure_ascii=False, sort_keys=True)


def _when(value: str | None) -> datetime:
    if not value:
        return datetime.now(timezone.utc)
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _matches_condition(namespace: tuple[str, ...], condition: MatchCondition) -> bool:
    path = tuple(condition.path)
    if len(path) > len(namespace):
        return False
    window = namespace[: len(path)] if condition.match_type == "prefix" else namespace[-len(path) :]
    return all(want in ("*", have) for want, have in zip(path, window, strict=True))


class MemDotStore(BaseStore):
    """Implements `batch`, which gives `get`, `put`, `search`, `delete` and `list_namespaces`."""

    def __init__(self, client: Any, *, namespace_id: str | None = None) -> None:
        self._client = client
        self._namespace_id = namespace_id

    def _user_of(self, namespace: tuple[str, ...]) -> str:
        """`("memories", "alex")` is about alex, so forgetting alex forgets these too."""
        return namespace[1] if len(namespace) > 1 else namespace[0]

    def _find(self, namespace: tuple[str, ...], key: str) -> Memory | None:
        page = self._client.memories.list(
            namespace_id=self._namespace_id,
            page_size=1,
            filters={
                "AND": [
                    {f"metadata.{_NAMESPACE}": _SEPARATOR.join(namespace)},
                    {f"metadata.{_KEY}": key},
                ]
            },
        )
        return page.results[0] if page.results else None

    def _fields(self, memory: Memory) -> tuple[tuple[str, ...], str, dict[str, Any]] | None:
        metadata = memory.metadata or {}
        if _KEY not in metadata or _NAMESPACE not in metadata:
            return None
        namespace = tuple(str(metadata[_NAMESPACE]).split(_SEPARATOR))
        value = metadata.get(_VALUE)
        return (
            namespace,
            str(metadata[_KEY]),
            value if isinstance(value, dict) else {"text": memory.memory},
        )

    def _item(self, memory: Memory) -> Item | None:
        fields = self._fields(memory)
        if not fields:
            return None
        namespace, key, value = fields
        return Item(
            value=value,
            key=key,
            namespace=namespace,
            created_at=_when(memory.created_at),
            updated_at=_when(memory.updated_at),
        )

    def _get(self, op: GetOp) -> Item | None:
        memory = self._find(op.namespace, op.key)
        return self._item(memory) if memory else None

    def _put(self, op: PutOp) -> None:
        current = self._find(op.namespace, op.key)
        if op.value is None:
            if current:
                self._client.memories.delete(current.id)
            return
        metadata = {
            _NAMESPACE: _SEPARATOR.join(op.namespace),
            _KEY: op.key,
            _VALUE: dict(op.value),
        }
        text = _text_of(op.value)
        if current:
            self._client.memories.update(current.id, text=text, metadata=metadata)
            return
        self._client.memories.add(
            text,
            user_id=self._user_of(op.namespace),
            namespace_id=self._namespace_id,
            metadata=metadata,
            infer=False,
        )

    def _under(self, memory: Memory, prefix: tuple[str, ...]) -> bool:
        fields = self._fields(memory)
        return bool(fields) and fields[0][: len(prefix)] == prefix

    def _search(self, op: SearchOp) -> list[SearchItem]:
        scope = {f"metadata.{_NAMESPACE}": {"contains": _SEPARATOR.join(op.namespace_prefix)}}
        wanted = op.limit + op.offset
        if op.query:
            found: list[Any] = self._client.memories.search(
                op.query,
                namespace_id=self._namespace_id,
                filters=scope,
                top_k=min(_MAX_FETCH, wanted * _SEARCH_OVERFETCH),
                threshold=0,
            )
        else:
            found = self._client.memories.list(
                namespace_id=self._namespace_id,
                filters=scope,
                page_size=min(_MAX_FETCH, wanted * _SEARCH_OVERFETCH),
            ).results
        items: list[SearchItem] = []
        for memory in found:
            fields = self._fields(memory)
            if not fields or not self._under(memory, op.namespace_prefix):
                continue
            namespace, key, value = fields
            if op.filter and any(value.get(k) != v for k, v in op.filter.items()):
                continue
            items.append(
                SearchItem(
                    namespace=namespace,
                    key=key,
                    value=value,
                    created_at=_when(memory.created_at),
                    updated_at=_when(memory.updated_at),
                    score=memory.score if isinstance(memory, ScoredMemory) else None,
                )
            )
        return items[op.offset : wanted]

    def _list_namespaces(self, op: ListNamespacesOp) -> list[tuple[str, ...]]:
        seen: dict[tuple[str, ...], None] = {}
        cursor = None
        while True:
            page = self._client.memories.list(
                namespace_id=self._namespace_id, page_size=_PAGE, cursor=cursor
            )
            for memory in page.results:
                fields = self._fields(memory)
                if fields:
                    seen[fields[0]] = None
            cursor = page.next_cursor
            if not cursor:
                break
        namespaces = sorted(seen)
        for condition in op.match_conditions or ():
            namespaces = [n for n in namespaces if _matches_condition(n, condition)]
        if op.max_depth is not None:
            namespaces = sorted({n[: op.max_depth] for n in namespaces})
        return namespaces[op.offset : op.offset + op.limit]

    def batch(self, ops: Iterable[Op]) -> list[Result]:
        results: list[Result] = []
        for op in ops:
            if isinstance(op, GetOp):
                results.append(self._get(op))
            elif isinstance(op, PutOp):
                results.append(self._put(op))
            elif isinstance(op, SearchOp):
                results.append(self._search(op))
            elif isinstance(op, ListNamespacesOp):
                results.append(self._list_namespaces(op))
            else:
                raise ValueError(f"Unknown store operation: {op}")
        return results

    async def abatch(self, ops: Iterable[Op]) -> list[Result]:
        return await asyncio.to_thread(self.batch, list(ops))


def memory_tools(
    client: Any,
    *,
    user_id: str | None = None,
    agent_id: str | None = None,
    namespace_id: str | None = None,
) -> list[StructuredTool]:
    """`remember` and `recall`, for an agent that decides for itself when to use them."""

    def scope() -> dict[str, str]:
        chosen = {"user_id": user_id, "agent_id": agent_id}
        return {key: value for key, value in chosen.items() if value}

    def remember(text: str) -> str:
        """Save a durable fact: a preference, a decision, a name. Not a secret."""
        added = client.memories.add(text, namespace_id=namespace_id, **scope())
        if added.note:
            return added.note
        return "Remembered." if added.results else "That's already remembered."

    def recall(query: str, top_k: int = 5) -> str:
        """Find what's been remembered, before answering anything that might depend on it."""
        hits = client.memories.search(
            query, namespace_id=namespace_id, filters=scope() or None, top_k=top_k
        )
        return "\n".join(f"- {hit.memory}" for hit in hits) or "Nothing remembered about that."

    return [
        StructuredTool.from_function(remember, name="remember"),
        StructuredTool.from_function(recall, name="recall"),
    ]
