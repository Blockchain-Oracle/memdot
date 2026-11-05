"""MemDot for the OpenAI Agents SDK.

    from agents import Agent, Runner
    from memdot import AsyncMemDot
    from memdot.integrations.openai_agents import MemDotSession, memory_tools

    memdot = AsyncMemDot()
    agent = Agent(name="Support", tools=memory_tools(memdot, user_id="alex"))
    await Runner.run(agent, "What do I deploy on?", session=MemDotSession("thread-1", memdot))

Tools are long-term memory. A session is one conversation's transcript, encrypted and on chain; it
doesn't help search, because it holds what was said rather than what's worth remembering.
"""

from __future__ import annotations

import json
import uuid
from typing import Any

from . import missing, notes

try:
    from agents import function_tool
    from agents.memory.session import SessionABC
except ImportError as error:
    missing("openai-agents", error)

_METADATA_KIND = "openai_agents_session_item"
_PAGE = 100


def memory_tools(
    client: Any,
    *,
    user_id: str | None = None,
    agent_id: str | None = None,
    namespace_id: str | None = None,
) -> list[Any]:
    """`search_memory` and `save_memory`, bound to who this agent works for."""

    def scope() -> dict[str, str]:
        chosen = {"user_id": user_id, "agent_id": agent_id}
        return {key: value for key, value in chosen.items() if value}

    @function_tool
    async def search_memory(query: str, top_k: int = 5) -> str:
        """Find what's been remembered, before answering anything that might depend on it.

        Args:
            query: What to look for.
            top_k: How many results.
        """
        hits = await client.memories.search(
            query, namespace_id=namespace_id, filters=scope() or None, top_k=top_k
        )
        return notes(hits)

    @function_tool
    async def save_memory(text: str) -> str:
        """Save a durable fact: a preference, a decision, a name. Not a secret.

        Args:
            text: The fact to keep.
        """
        added = await client.memories.add(text, namespace_id=namespace_id, **scope())
        if added.note:
            return added.note
        return "Remembered." if added.results else "That's already remembered."

    return [search_memory, save_memory]


class MemDotSession(SessionABC):
    """A conversation's items, stored as written under `run_id = session_id`, oldest first."""

    def __init__(self, session_id: str, client: Any, *, namespace_id: str | None = None) -> None:
        self.session_id = session_id
        self.session_settings = None
        self._client = client
        self._namespace_id = namespace_id

    async def _rows(self) -> list[Any]:
        rows: list[Any] = []
        cursor = None
        while True:
            page = await self._client.memories.list(
                namespace_id=self._namespace_id,
                filters={"run_id": self.session_id, f"metadata.{_METADATA_KIND}": True},
                page_size=_PAGE,
                cursor=cursor,
            )
            rows.extend(page.results)
            cursor = page.next_cursor
            if not cursor:
                break
        return sorted(rows, key=lambda row: (row.metadata or {}).get("position", 0))

    async def get_items(self, limit: int | None = None) -> list[Any]:
        rows = await self._rows()
        selected = rows[-limit:] if limit else rows
        return [json.loads(row.memory)["item"] for row in selected]

    async def add_items(self, items: list[Any]) -> None:
        position = len(await self._rows())
        for offset, item in enumerate(items):
            # A nonce, because saying "ok" twice is two turns and not a repeated fact.
            text = json.dumps({"nonce": str(uuid.uuid4()), "item": item}, ensure_ascii=False)
            await self._client.memories.add(
                text,
                run_id=self.session_id,
                namespace_id=self._namespace_id,
                metadata={_METADATA_KIND: True, "position": position + offset},
                infer=False,
            )

    async def pop_item(self) -> Any | None:
        rows = await self._rows()
        if not rows:
            return None
        await self._client.memories.delete(rows[-1].id)
        return json.loads(rows[-1].memory)["item"]

    async def clear_session(self) -> None:
        await self._client.memories.delete_all(
            run_id=self.session_id, namespace_id=self._namespace_id
        )
