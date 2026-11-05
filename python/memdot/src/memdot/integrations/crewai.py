"""Tools that let a CrewAI agent remember and recall.

    from crewai import Agent
    from memdot import MemDot
    from memdot.integrations.crewai import memory_tools

    agent = Agent(role="Support", goal="…", backstory="…",
                  tools=memory_tools(MemDot.from_credentials(), user_id="alex"))

Tools rather than a storage backend: CrewAI's backend hands over vectors it embedded itself, and
MemDot embeds on its own side, on the server or on your machine.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from . import missing, notes

try:
    from crewai.tools import BaseTool
except ImportError as error:
    missing("crewai", error)


class _RememberInput(BaseModel):
    text: str = Field(description="The fact to keep: a preference, a decision, a name.")


class _RecallInput(BaseModel):
    query: str = Field(description="What to look for.")
    top_k: int = Field(default=5, description="How many results.")


class _MemDotTool(BaseTool):
    client: Any = Field(exclude=True)
    user_id: str | None = None
    agent_id: str | None = None
    namespace_id: str | None = None

    def _scope(self) -> dict[str, str]:
        chosen = {"user_id": self.user_id, "agent_id": self.agent_id}
        return {key: value for key, value in chosen.items() if value}


class MemDotRememberTool(_MemDotTool):
    name: str = "remember"
    description: str = "Save a durable fact: a preference, a decision, a name. Not a secret."
    args_schema: type[BaseModel] = _RememberInput

    def _run(self, text: str) -> str:
        added = self.client.memories.add(text, namespace_id=self.namespace_id, **self._scope())
        if added.note:
            return added.note
        return "Remembered." if added.results else "That's already remembered."


class MemDotRecallTool(_MemDotTool):
    name: str = "recall"
    description: str = "Find what's been remembered, before answering anything that depends on it."
    args_schema: type[BaseModel] = _RecallInput

    def _run(self, query: str, top_k: int = 5) -> str:
        hits = self.client.memories.search(
            query, namespace_id=self.namespace_id, filters=self._scope() or None, top_k=top_k
        )
        return notes(hits)


def memory_tools(
    client: Any,
    *,
    user_id: str | None = None,
    agent_id: str | None = None,
    namespace_id: str | None = None,
) -> list[BaseTool]:
    """`remember` and `recall`, bound to who this agent works for."""
    bound = {
        "client": client,
        "user_id": user_id,
        "agent_id": agent_id,
        "namespace_id": namespace_id,
    }
    return [MemDotRememberTool(**bound), MemDotRecallTool(**bound)]
