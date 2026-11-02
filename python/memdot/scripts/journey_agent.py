"""The agent's half of `pnpm --filter @memdot/sdk journey:python`: what an agent builder's code does.

Connected with `memdot login` from Python, on keys the owner shared with it. Takes what the owner did
as JSON on stdin, prints a line per check, and ends with what the owner should find afterwards.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import secrets
import sys

from memdot import AsyncMemDot, ForbiddenError, MemDot, MemDotError

failures: list[str] = []


def check(name: str, passed: bool, detail: object = "") -> None:
    print(json.dumps({"check": name, "ok": passed, "detail": str(detail)[:300]}), flush=True)
    if not passed:
        failures.append(name)


def recall_through_mcp(memdot: MemDot, query: str, namespace_id: str) -> dict:
    """The Python MCP server's own tools, over its real protocol in memory."""
    from mcp.shared.memory import create_connected_server_and_client_session

    from memdot.mcp_server import build_server

    server = build_server(memdot, namespace_id=namespace_id)

    async def run() -> dict:
        async with create_connected_server_and_client_session(server._mcp_server) as session:
            tools = (await session.list_tools()).tools
            result = await session.call_tool("search_memories", {"query": query})
            return {
                "tools": [tool.name for tool in tools],
                "body": json.loads(result.content[0].text),
            }

    return asyncio.run(run())


async def recall_async(query: str, namespace_id: str) -> list:
    async with await AsyncMemDot.from_credentials(client="kofi-async") as memdot:
        return await memdot.search(query, namespace_id=namespace_id)


def main() -> None:
    given = json.load(sys.stdin)
    private, assisted = given["privateNamespace"], given["assistedNamespace"]
    memdot = MemDot.from_credentials(client="kofi-agent")

    # What the owner uploaded through the same SDK the dashboard uses.
    opened = memdot.files.get(given["fileId"])
    digest = hashlib.sha256(opened.data).hexdigest()
    check("reads the file the owner uploaded", digest == given["fileSha"], opened.name)
    check("sees its name, decrypted here", opened.name == given["fileName"], opened.name)
    large = memdot.files.get(given["chunkedFileId"])
    check(
        "reads one stored as chunks and a manifest",
        hashlib.sha256(large.data).hexdigest() == given["chunkedFileSha"],
        len(large.data),
    )
    verified = memdot.files.verify(given["fileId"])
    check("checks it against the chain, not MemDot", verified.ok, verified.to_dict())
    names = {file.name for file in memdot.files.list(space_id=given["spaceId"]).items}
    check("lists the owner's files by name", given["fileName"] in names, sorted(names))

    # A memory the owner wrote in TypeScript, in a Private namespace.
    hits = memdot.memories.search(given["ownerQuery"], namespace_id=private)
    check(
        "recalls what the owner wrote, on this machine",
        bool(hits) and hits[0].memory == given["ownerFact"],
        hits and hits[0].to_dict(),
    )

    # The agent's own memory, in the mode it chose per namespace.
    stamp = secrets.token_hex(3)
    user = f"customer-{stamp}"
    fact_private = f"{user} keeps their invoices in euros."
    fact_assisted = f"{user} prefers a call to an email."
    added = memdot.add(fact_private, user_id=user, namespace_id=private, infer=False, wait="chain")
    check("remembers in Private, to the chain", len(added.results) == 1, added.to_dict())
    event = memdot.add(fact_assisted, user_id=user, namespace_id=assisted, infer=False)
    check("remembers in Assisted", len(event.results) == 1, event.to_dict())

    near = memdot.search("what currency for invoices", user_id=user, namespace_id=private)
    check("recalls by meaning in Private", bool(near) and near[0]["memory"] == fact_private, near)
    far = memdot.search("how should we contact them", user_id=user, namespace_id=assisted)
    check("recalls by meaning in Assisted", bool(far) and far[0]["memory"] == fact_assisted, far)

    # Another session, with nothing but what `memdot login` saved.
    later = MemDot.from_credentials(client="kofi-next-session")
    again = later.search("invoices currency", user_id=user, namespace_id=private)
    check("a new session recalls it", bool(again) and again[0].memory == fact_private)
    async_hits = asyncio.run(recall_async("invoices currency", private))
    check("the async client recalls it too", any(h.memory == fact_private for h in async_hits))

    # Coming back to inspect, export and forget one person.
    listed = later.get_all(user_id=user, namespace_id=private)
    check("lists one person's memories", listed.count == 1, listed.count)
    history = later.history(listed.results[0].id)
    check("sees how a memory changed", history[0].event == "ADD")
    exported = later.memories.export_memories(private)
    check("exports them", any(row["memory"] == fact_private for row in exported), len(exported))

    through_mcp = recall_through_mcp(later, "invoices currency", private)
    check(
        "the Python MCP server recalls it",
        fact_private in json.dumps(through_mcp["body"]),
        through_mcp["body"].get("count"),
    )
    check("and offers files too", {"list_files", "upload_file"} <= set(through_mcp["tools"]))

    wrote = memdot.files.put(
        f"Written by the Python agent {stamp}".encode(),
        space_id=given["spaceId"],
        name=f"from-python-{stamp}.txt",
        mime="text/plain",
    )
    check("stores a file the owner can open", wrote.job.status == "finalized", wrote.job.tx_hash)
    kept = f"The Python agent {stamp} leaves this for the owner."
    left = memdot.add(kept, user_id="owner", namespace_id=private, infer=False, wait="chain")
    check("leaves a memory for the owner", len(left.results) == 1)

    forgotten = later.delete_all(user_id=user, namespace_id=private)
    check("forgets one person in Private", forgotten == 1, forgotten)
    gone = later.search("invoices currency", user_id=user, namespace_id=private)
    check("and it's gone from search", gone == [], gone)
    later.delete_all(user_id=user, namespace_id=assisted)

    # What an agent can't do.
    try:
        memdot.spaces.create("Not mine")
        check("can't create a space, which takes the owner's key", False)
    except MemDotError as error:
        check("can't create a space, which takes the owner's key", error.code == "OWNER_ONLY")
    try:
        memdot.keys.list()
        check("can't see the account's API keys", False)
    except ForbiddenError:
        check("can't see the account's API keys", True)

    print(
        json.dumps(
            {
                "result": {
                    "fileId": wrote.file.id,
                    "fileBytes": f"Written by the Python agent {stamp}",
                    "memoryId": left.results[0].id,
                    "memory": kept,
                    "memoryJob": left.event_id,
                    "failures": failures,
                }
            }
        )
    )


def after_revoke() -> None:
    memdot = MemDot.from_credentials(client="kofi-revoked")
    try:
        memdot.spaces.list()
        check("revoked, the key stops", False)
    except MemDotError as error:
        check("revoked, the key stops", error.status == 401, error.code)


if __name__ == "__main__":
    after_revoke() if "--after-revoke" in sys.argv else main()
    sys.exit(1 if failures else 0)
