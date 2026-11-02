"""Memory for Strands Agents: recalled before each turn, kept as the agent works.

    from strands import Agent
    from strands.memory import MemoryManager
    from memdot import AsyncMemDot
    from memdot.integrations.strands import MemDotMemoryStore

    store = MemDotMemoryStore(AsyncMemDot(), user_id="alex")
    agent = Agent(memory_manager=MemoryManager(stores=[store]))

`memdot_tool` gives an agent the same memory as one tool, for when it should decide for itself.
"""

from __future__ import annotations

import json
from typing import Any

from . import missing

try:
    from strands import tool
    from strands.memory.types import MemoryEntry
except ImportError as error:
    missing("strands", error)

_DEFAULT_RESULTS = 5
_LIST_PAGE = 20


def _message_text(message: Any) -> str:
    content = message.get("content") if isinstance(message, dict) else None
    if isinstance(content, str):
        return content
    return " ".join(
        block["text"] for block in content or [] if isinstance(block, dict) and block.get("text")
    )


class MemDotMemoryStore:
    """Meets Strands' `MemoryStore` protocol, on the async client."""

    def __init__(
        self,
        client: Any,
        *,
        user_id: str | None = None,
        agent_id: str | None = None,
        run_id: str | None = None,
        namespace_id: str | None = None,
        name: str = "memdot",
        description: str | None = "Encrypted long-term memory on Portaldot V3.",
        max_search_results: int | None = _DEFAULT_RESULTS,
        writable: bool = True,
        extraction: Any = False,
    ) -> None:
        self._client = client
        self._scope = {
            key: value
            for key, value in (("user_id", user_id), ("agent_id", agent_id), ("run_id", run_id))
            if value
        }
        self._namespace_id = namespace_id
        self.name = name
        self.description = description
        self.max_search_results = max_search_results
        self.writable = writable
        self.extraction = extraction

    async def search(self, query: str, options: dict[str, Any] | None = None) -> list[MemoryEntry]:
        limit = (options or {}).get("max_search_results") or self.max_search_results
        hits = await self._client.memories.search(
            query,
            namespace_id=self._namespace_id,
            filters=self._scope or None,
            top_k=limit or _DEFAULT_RESULTS,
        )
        return [
            MemoryEntry(
                content=hit.memory,
                metadata={"id": hit.id, "score": hit.score, "created_at": hit.created_at},
            )
            for hit in hits
        ]

    async def add(self, content: str, metadata: dict[str, Any] | None = None) -> Any:
        """Stored as written: the agent already decided this is worth keeping."""
        return await self._client.memories.add(
            content,
            namespace_id=self._namespace_id,
            metadata=metadata,
            infer=False,
            **self._scope,
        )

    async def add_messages(self, messages: list[Any], context: Any = None) -> Any:
        """A batch of conversation, for a model to distill: yours in Private, MemDot's in Assisted."""
        turns = [
            {"role": message["role"], "content": text}
            for message in messages
            if isinstance(message, dict) and (text := _message_text(message))
        ]
        if not turns:
            return None
        return await self._client.memories.add(
            turns, namespace_id=self._namespace_id, **self._scope
        )

    async def initialize(self) -> None:
        return None

    def get_tools(self) -> list[Any]:
        return []


def memdot_tool(
    client: Any,
    *,
    user_id: str | None = None,
    agent_id: str | None = None,
    namespace_id: str | None = None,
) -> Any:
    """One tool over the async client, bound to who this agent works for."""
    scope = {k: v for k, v in (("user_id", user_id), ("agent_id", agent_id)) if v}

    @tool
    async def memdot_memory(
        action: str,
        content: str | None = None,
        query: str | None = None,
        memory_id: str | None = None,
    ) -> str:
        """Long-term memory, encrypted and stored on Portaldot V3.

        Args:
            action: One of store, retrieve, list, get, delete or history.
            content: What to remember, for store.
            query: What to look for, for retrieve.
            memory_id: Which memory, for get, delete and history.
        """
        memories = client.memories
        if action == "store" and content:
            added = await memories.add(content, namespace_id=namespace_id, **scope)
            return added.note or json.dumps([r.to_dict() for r in added.results])
        if action == "retrieve" and query:
            hits = await memories.search(query, namespace_id=namespace_id, filters=scope or None)
            return json.dumps([{"id": h.id, "memory": h.memory, "score": h.score} for h in hits])
        if action == "list":
            page = await memories.list(
                namespace_id=namespace_id, filters=scope or None, page_size=_LIST_PAGE
            )
            return json.dumps([{"id": m.id, "memory": m.memory} for m in page.results])
        if action == "get" and memory_id:
            return json.dumps((await memories.get(memory_id)).to_dict())
        if action == "delete" and memory_id:
            await memories.delete(memory_id)
            return "Forgotten."
        if action == "history" and memory_id:
            return json.dumps([event.to_dict() for event in await memories.history(memory_id)])
        return f"Can't {action} with that. Store takes content, retrieve a query, the rest an id."

    return memdot_memory
