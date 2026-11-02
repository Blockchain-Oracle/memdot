"""What the client must never do, checked at the wire."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest

from memdot import MemDot, Wallet, crypto
from memdot._async.agents import API_KEY_FORMAT
from memdot.credentials import (
    ResolvedCredentials,
    dashboard_origin,
    for_api,
    resolve_credentials,
    same_origin,
)
from memdot.errors import MemDotError
from memdot.models import FileData

NAMESPACE = "6360b4bb-7814-4e96-bc7a-c8b568ff9d0d"


def client(mode: str = "private", **options: Any) -> tuple[MemDot, list[httpx.Request]]:
    """A client whose API knows one namespace, in this mode, and answers little else."""
    seen: list[httpx.Request] = []

    def answer(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path == "/v1/namespaces":
            row = {"id": NAMESPACE, "space_id": "s", "mode": mode, "key_epoch": 0}
            return httpx.Response(200, json={"results": [row]})
        if request.url.path == "/v1/memories" and request.method == "POST":
            return httpx.Response(
                200, json={"event_id": "e", "status": "PENDING", "namespace_id": NAMESPACE}
            )
        return httpx.Response(404, json={"error": {"code": "NOT_FOUND", "message": "no"}})

    http = httpx.Client(transport=httpx.MockTransport(answer))
    return MemDot("md_x", base_url="http://api.test", http=http, **options), seen


def test_a_default_private_namespace_keeps_text_on_this_machine():
    memdot, seen = client(namespace_id=NAMESPACE)
    with pytest.raises(MemDotError):
        # It stops at reading the namespace's state. What matters is what it didn't send.
        memdot.add("a secret fact", user_id="u")
    assert all(r.url.path != "/v1/memories" for r in seen)
    assert all(b"a secret fact" not in r.content for r in seen)


def test_a_default_assisted_namespace_is_named_to_the_api():
    memdot, seen = client("assisted", namespace_id=NAMESPACE)
    memdot.add("a fact", user_id="u", wait=False)
    sent = next(r for r in seen if r.url.path == "/v1/memories")
    assert json.loads(sent.content)["namespace_id"] == NAMESPACE


@pytest.mark.parametrize(
    ("call", "expected"),
    [
        (
            lambda m: m.memories.delete_entity("user", "priya#work"),
            "/v1/entities/user/priya%23work",
        ),
        (lambda m: m.memories.delete("../objects/abc"), "/v1/memories/..%2Fobjects%2Fabc"),
        (lambda m: m.memories.history("a/b?c=d"), "/v1/memories/a%2Fb%3Fc%3Dd/history"),
    ],
)
def test_an_id_stays_one_path_segment(call: Any, expected: str):
    memdot, seen = client()
    with pytest.raises(MemDotError):
        call(memdot)
    assert any(r.url.raw_path.decode().split("?")[0] == expected for r in seen), [
        r.url.raw_path for r in seen
    ]


def test_nan_is_refused_rather_than_sealed():
    with pytest.raises(ValueError, match="JSON"):
        crypto.dumps({"score": float("nan")})


def test_a_key_is_the_whole_string():
    assert API_KEY_FORMAT.fullmatch("md_abc-DEF_1")
    assert not API_KEY_FORMAT.fullmatch("md_abc\n")
    assert not API_KEY_FORMAT.fullmatch('md_abc"; rm -rf ~; "')


def test_origins_compare_as_a_browser_does():
    assert same_origin("https://API.example.com:443/x", "https://api.example.com")
    assert not same_origin("https://api.example.com", "http://api.example.com")
    assert not same_origin("https://api.example.com", "https://api.example.com:8443")
    assert not same_origin("not a url", "not a url")


def test_a_saved_key_goes_only_where_it_was_saved_for():
    saved = {"api_url": "https://api.a.test", "api_key": "md_a", "agent": {"identity": "AGE"}}
    assert resolve_credentials(saved, {"api_url": "https://api.a.test"}).api_key == "md_a"
    elsewhere = resolve_credentials(saved, {"api_url": "https://evil.test"})
    assert elsewhere.api_key is None and elsewhere.identity is None


def test_moving_to_another_address_leaves_the_key_behind():
    saved = {"api_url": "https://api.a.test", "api_key": "md_a", "agent": {}, "namespace_id": "n"}
    assert for_api(saved, "https://api.a.test")["api_key"] == "md_a"
    moved = for_api(saved, "https://evil.test")
    assert "api_key" not in moved and "agent" not in moved and "namespace_id" not in moved


def test_the_dashboard_is_only_guessed_when_it_can_be():
    assert dashboard_origin("https://api.memdot.xyz") == "https://app.memdot.xyz"
    assert dashboard_origin("http://localhost:8787") == "http://localhost:3100"
    assert dashboard_origin("https://memdot.internal") is None


def test_secrets_stay_out_of_reprs_and_json():
    wallet = Wallet("addr", b"p", b"the-secret")
    assert "the-secret" not in repr(wallet)
    resolved = ResolvedCredentials(
        api_url="u",
        api_key="md_key",
        identity="AGE-SECRET",
        namespace_id=None,
        user_id=None,
        agent_id=None,
        run_id=None,
        recovery_code="twelve words",
        api_key_source=None,
    )
    assert not {"md_key", "AGE-SECRET", "twelve words"} & set(repr(resolved).split("'"))
    assert "data" not in FileData(data=b"\xff\xfe", name="n", mime="m").to_dict()


def test_mcp_tools_take_ids_and_nothing_else():
    pytest.importorskip("mcp")
    from mcp.shared.memory import create_connected_server_and_client_session

    from memdot.mcp_server import build_server

    memdot, seen = client()
    server = build_server(memdot)

    async def call() -> tuple[Any, Any]:
        async with create_connected_server_and_client_session(server._mcp_server) as session:
            climbing = await session.call_tool("delete_memory", {"memory_id": "../objects/abc"})
            unsafe = await session.call_tool(
                "add_memory",
                {"messages": [{"role": "user", "content": [{"type": "txt_url"}]}], "user_id": "u"},
            )
            return climbing, unsafe

    climbing, unsafe = asyncio.run(call())
    assert climbing.isError and unsafe.isError
    assert not [r for r in seen if r.method == "DELETE" or r.url.path == "/v1/memories"]
