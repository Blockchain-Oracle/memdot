"""Each provider's request and answer, and falling back when a model can't answer."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx
import pytest

from memdot._async import llm
from memdot._async.llm import AsyncModel, ModelError

MESSAGES = [{"role": "user", "content": "I deploy on Fridays"}]
EXTRACTED = {
    "memories": [
        {
            "text": "Deploys on Fridays",
            "attributed_to": "user",
            "entities": [],
            "categories": ["work"],
        }
    ]
}


def model(config: dict[str, Any], answers: list[tuple[int, Any]]) -> tuple[AsyncModel, list[Any]]:
    seen: list[httpx.Request] = []

    def answer(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        status, body = answers[min(len(seen) - 1, len(answers) - 1)]
        return httpx.Response(status, json=body)

    http = httpx.AsyncClient(transport=httpx.MockTransport(answer))
    return AsyncModel(config, http), seen


def extract(built: AsyncModel) -> list[dict[str, Any]]:
    return asyncio.run(
        llm.extract_memories(
            built,
            messages=MESSAGES,
            known=[],
            instructions=None,
            categories=None,
            observed_at="2026-11-02T10:00:00.000Z",
            agent_scoped=False,
        )
    )


def test_openai_asks_for_the_schema_and_reads_the_answer():
    built, seen = model(
        {"provider": "openai", "model": "m", "apiKey": "k"},
        [(200, {"choices": [{"message": {"content": json.dumps(EXTRACTED)}}]})],
    )
    assert extract(built)[0]["text"] == "Deploys on Fridays"
    assert str(seen[0].url) == "https://api.openai.com/v1/chat/completions"
    assert seen[0].headers["authorization"] == "Bearer k"
    assert json.loads(seen[0].content)["response_format"]["type"] == "json_schema"


def test_a_stale_address_is_only_used_by_a_compatible_provider():
    built, seen = model(
        {"provider": "openai", "model": "m", "apiKey": "k", "baseUrl": "https://old.test/v1"},
        [(200, {"choices": [{"message": {"content": json.dumps(EXTRACTED)}}]})],
    )
    extract(built)
    assert seen[0].url.host == "api.openai.com"


def test_a_compatible_provider_uses_its_address_and_plain_json_mode():
    built, seen = model(
        {
            "provider": "openai-compatible",
            "model": "m",
            "apiKey": "k",
            "baseUrl": "https://mine.test/v1",
        },
        [(200, {"choices": [{"message": {"content": json.dumps(EXTRACTED)}}]})],
    )
    extract(built)
    assert str(seen[0].url) == "https://mine.test/v1/chat/completions"
    assert json.loads(seen[0].content)["response_format"] == {"type": "json_object"}


def test_anthropic_answers_through_a_tool():
    built, seen = model(
        {"provider": "anthropic", "model": "m", "apiKey": "k"},
        [(200, {"content": [{"type": "tool_use", "input": EXTRACTED}]})],
    )
    assert extract(built)[0]["categories"] == ["work"]
    assert seen[0].headers["x-api-key"] == "k"
    sent = json.loads(seen[0].content)
    assert sent["tool_choice"] == {"type": "tool", "name": "output"}


def test_google_gets_a_schema_it_can_read():
    built, seen = model(
        {"provider": "google", "model": "gemini", "apiKey": "k"},
        [(200, {"candidates": [{"content": {"parts": [{"text": json.dumps(EXTRACTED)}]}}]})],
    )
    extract(built)
    assert seen[0].url.path.endswith("/models/gemini:generateContent")
    assert b"additionalProperties" not in seen[0].content


@pytest.mark.parametrize("status", [429, 404, 503])
def test_the_next_model_takes_over(status: int):
    good = (200, {"choices": [{"message": {"content": json.dumps(EXTRACTED)}}]})
    built, seen = model(
        {"provider": "openai", "model": "first, second", "apiKey": "k"}, [(status, {}), good]
    )
    extract(built)
    assert [json.loads(r.content)["model"] for r in seen] == ["first", "second"]
    # The one that failed rests: the next call goes straight to the other.
    extract(built)
    assert json.loads(seen[-1].content)["model"] == "second"


def test_a_bad_key_is_not_worth_trying_elsewhere():
    built, seen = model(
        {"provider": "openai", "model": "first, second", "apiKey": "k"}, [(401, {})]
    )
    with pytest.raises(ModelError):
        extract(built)
    assert len(seen) == 1


def test_a_malformed_answer_is_a_model_error():
    built, _ = model(
        {"provider": "openai", "model": "m", "apiKey": "k"},
        [(200, {"choices": [{"message": {"content": '{"memories":[{"text":"x"}]}'}}]})],
    )
    with pytest.raises(ModelError):
        extract(built)
