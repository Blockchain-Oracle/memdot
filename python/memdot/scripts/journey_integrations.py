"""Each framework integration against a running API, with the framework really installed.

Needs a connected agent (`memdot login`) and `memdot[langgraph,crewai,strands,openai-agents]`. Calls
tools and stores directly and runs a LangGraph graph of plain functions, so no model key is used.
"""

from __future__ import annotations

import asyncio
import json
import secrets
import sys
from typing import Any, TypedDict

from memdot import AsyncMemDot, MemDot
from memdot.credentials import load_credentials, resolve_credentials

failures: list[str] = []


def check(name: str, passed: bool, detail: object = "") -> None:
    print(
        f"{'ok  ' if passed else 'FAIL'} {name}{f'  {detail}' if detail != '' else ''}", flush=True
    )
    if not passed:
        failures.append(name)


resolved = resolve_credentials(load_credentials())
NAMESPACE = resolved.namespace_id
stamp = secrets.token_hex(3)


def langgraph() -> None:
    from langgraph.graph import END, START, StateGraph
    from langgraph.store.base import BaseStore

    from memdot.integrations.langgraph import MemDotStore, memory_tools

    client = MemDot.from_credentials(client="py-langgraph")
    store = MemDotStore(client, namespace_id=NAMESPACE)
    check("LangGraph: it is a real store", isinstance(store, BaseStore))
    space = ("memories", f"alex-{stamp}")
    store.put(space, "deploys", {"text": f"Alex {stamp} deploys on Fridays", "team": "payments"})
    got = store.get(space, "deploys")
    check(
        "LangGraph: put, then get by key", got is not None and got.value["team"] == "payments", got
    )
    store.put(space, "deploys", {"text": f"Alex {stamp} deploys on Mondays", "team": "payments"})
    again = store.get(space, "deploys")
    check(
        "LangGraph: put again updates it",
        again is not None and "Mondays" in again.value["text"],
        again,
    )
    found = store.search(("memories",), query=f"when does Alex {stamp} deploy", limit=3)
    check(
        "LangGraph: search by meaning, under a prefix",
        bool(found) and found[0].key == "deploys",
        found,
    )
    check("LangGraph: results carry a score", found[0].score is not None, found[0].score)
    narrowed = store.search(space, filter={"team": "sales"})
    check("LangGraph: filter on the value", narrowed == [], narrowed)
    check("LangGraph: lists namespaces", space in store.list_namespaces(prefix=("memories",)))

    class State(TypedDict):
        question: str
        answer: str

    def recall(state: State, *, store: BaseStore) -> dict[str, str]:
        hits = store.search(space, query=state["question"], limit=1)
        return {"answer": hits[0].value["text"] if hits else ""}

    builder = StateGraph(State)
    builder.add_node("recall", recall)
    builder.add_edge(START, "recall")
    builder.add_edge("recall", END)
    answer = builder.compile(store=store).invoke({"question": "when do they deploy", "answer": ""})
    check("LangGraph: a compiled graph reads the store", "Mondays" in answer["answer"], answer)

    async def in_async() -> Any:
        await store.aput(space, "lunch", {"text": f"Alex {stamp} eats at noon"})
        return await store.aget(space, "lunch")

    check("LangGraph: the async side works", asyncio.run(in_async()) is not None)
    store.delete(space, "deploys")
    store.delete(space, "lunch")
    check("LangGraph: delete by key", store.get(space, "deploys") is None)

    tools = {t.name: t for t in memory_tools(client, user_id=f"lc-{stamp}", namespace_id=NAMESPACE)}
    tools["remember"].invoke({"text": f"LangChain user {stamp} likes tea"})
    recalled = tools["recall"].invoke({"query": "what do they drink"})
    check("LangChain: tools remember and recall", "tea" in recalled, recalled)
    client.memories.delete_all(user_id=f"lc-{stamp}", namespace_id=NAMESPACE)


def crewai() -> None:
    from crewai.tools import BaseTool

    from memdot.integrations.crewai import memory_tools

    client = MemDot.from_credentials(client="py-crewai")
    remember, recall = memory_tools(client, user_id=f"crew-{stamp}", namespace_id=NAMESPACE)
    check(
        "CrewAI: they are real tools",
        isinstance(remember, BaseTool) and remember.name == "remember",
    )
    result = remember.run(text=f"Crew member {stamp} works nights")
    check("CrewAI: remembers", isinstance(result, str) and bool(result), result)
    found = recall.run(query="when do they work")
    check("CrewAI: recalls", "nights" in found, found)
    client.memories.delete_all(user_id=f"crew-{stamp}", namespace_id=NAMESPACE)


async def strands() -> None:
    from strands.memory import MemoryManager

    from memdot.integrations.strands import MemDotMemoryStore, memdot_tool

    async with await AsyncMemDot.from_credentials(client="py-strands") as client:
        user = f"strands-{stamp}"
        store = MemDotMemoryStore(client, user_id=user, namespace_id=NAMESPACE)
        manager = MemoryManager(stores=[store])
        check("Strands: its manager accepts the store", manager is not None)
        await store.add(f"Strands user {stamp} flies from Lagos")
        entries = await store.search("where do they fly from")
        check("Strands: add, then search", bool(entries) and "Lagos" in entries[0].content, entries)
        limited = await store.search("where do they fly from", {"max_search_results": 1})
        check("Strands: honours the result limit", len(limited) == 1)
        await store.add_messages(
            [{"role": "user", "content": [{"text": f"User {stamp} also flies from Accra"}]}]
        )
        more = await store.search("Accra")
        check("Strands: takes a batch of messages", any("Accra" in e.content for e in more), more)

        memory = memdot_tool(client, user_id=user, namespace_id=NAMESPACE)
        check(
            "Strands: the tool has its name", memory.tool_name == "memdot_memory", memory.tool_name
        )
        spec = memory.tool_spec["inputSchema"]["json"]["properties"]
        check("Strands: the tool describes its arguments", {"action", "query"} <= set(spec), spec)
        await client.memories.delete_all(user_id=user, namespace_id=NAMESPACE)


async def openai_agents() -> None:
    from agents import FunctionTool
    from agents.tool_context import ToolContext

    from memdot.integrations.openai_agents import MemDotSession, memory_tools

    async with await AsyncMemDot.from_credentials(client="py-openai-agents") as client:
        user = f"oa-{stamp}"
        search, save = memory_tools(client, user_id=user, namespace_id=NAMESPACE)
        check("OpenAI Agents: they are function tools", isinstance(save, FunctionTool), save.name)

        async def call(tool: Any, **arguments: Any) -> str:
            raw = json.dumps(arguments)
            context = ToolContext(
                context=None, tool_name=tool.name, tool_call_id="call", tool_arguments=raw
            )
            return await tool.on_invoke_tool(context, raw)

        saved = await call(save, text=f"Agents user {stamp} wants weekly reports")
        # Without a model for this Private namespace it says so, and keeps the text as written.
        check("OpenAI Agents: saves", "Remembered" in saved or "as written" in saved, saved)
        found = await call(search, query="how often do they want reports")
        check("OpenAI Agents: searches", "weekly" in found, found)

        session = MemDotSession(f"thread-{stamp}", client, namespace_id=NAMESPACE)
        first = {"role": "user", "content": "ok"}
        second = {"role": "assistant", "content": "ok"}
        await session.add_items([first, second, first])
        items = await session.get_items()
        check(
            "OpenAI Agents: a session keeps repeats, in order",
            items == [first, second, first],
            items,
        )
        check(
            "OpenAI Agents: asks for the latest only", await session.get_items(limit=1) == [first]
        )
        check("OpenAI Agents: pops the last", await session.pop_item() == first)
        await session.clear_session()
        check("OpenAI Agents: clears", await session.get_items() == [])
        await client.memories.delete_all(user_id=user, namespace_id=NAMESPACE)


if __name__ == "__main__":
    langgraph()
    crewai()
    asyncio.run(strands())
    asyncio.run(openai_agents())
    print(json.dumps({"failures": failures}))
    sys.exit(1 if failures else 0)
