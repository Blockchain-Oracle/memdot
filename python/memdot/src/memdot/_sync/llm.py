# Generated from ../_async by scripts/unasync.py. Edit that, not this.
"""Calling a model from this device, with the account's own key, for Private namespaces.

Each provider's own HTTP API, because that's all this needs and it keeps the install small. `model`
may list several, comma-separated: the next one takes over whenever one is over its quota or down.
"""

from __future__ import annotations

import base64
import json
import re
import time
from typing import Any
from urllib.parse import unquote

import httpx

from ..engine import PROMPTS

#: No model call waits longer than this; a stalled provider must not hold anything up.
_MODEL_TIMEOUT_SECONDS = 120.0
#: How long a model that hit its quota is left alone before it's asked again.
_QUOTA_COOLDOWN_SECONDS = 60.0
_ANTHROPIC_MAX_TOKENS = 4096
_DATA_URL = re.compile(r"^data:([^;,]+)(;base64)?,(.*)$", re.DOTALL)

_EXTRACTION = {
    "type": "object",
    "properties": {
        "memories": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "text": {"type": "string"},
                    "attributed_to": {"type": "string", "enum": ["user", "assistant"]},
                    "entities": {"type": "array", "items": {"type": "string"}},
                    "categories": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["text", "attributed_to", "entities", "categories"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["memories"],
    "additionalProperties": False,
}
_RELEVANCE = {
    "type": "object",
    "properties": {"scores": {"type": "array", "items": {"type": "number"}}},
    "required": ["scores"],
    "additionalProperties": False,
}
_INSTRUCTIONS = {
    "type": "object",
    "properties": {
        "custom_instructions": {"type": "string"},
        "test_message": {"type": "string"},
    },
    "required": ["custom_instructions", "test_message"],
    "additionalProperties": False,
}


class ModelError(Exception):
    def __init__(self, status: int | None, message: str) -> None:
        super().__init__(message)
        self.status = status

    @property
    def worth_trying_next(self) -> bool:
        """Over quota, retired, down, or unreachable: another model may well answer."""
        return self.status is None or self.status in (404, 429) or self.status >= 500


def _without_additional(schema: Any) -> Any:
    """Google's schema format has no `additionalProperties`."""
    if isinstance(schema, dict):
        return {
            key: _without_additional(value)
            for key, value in schema.items()
            if key != "additionalProperties"
        }
    return [_without_additional(item) for item in schema] if isinstance(schema, list) else schema


def _data_url(part: dict[str, Any]) -> str:
    return f"data:{part['media_type']};base64,{base64.b64encode(part['data']).decode()}"


def _openai_content(parts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    content: list[dict[str, Any]] = []
    for part in parts:
        if part["type"] == "text":
            content.append({"type": "text", "text": part["text"]})
        elif part["media_type"].startswith("image"):
            content.append({"type": "image_url", "image_url": {"url": _data_url(part)}})
        else:
            content.append(
                {"type": "file", "file": {"filename": "document", "file_data": _data_url(part)}}
            )
    return content


def _anthropic_content(parts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    content: list[dict[str, Any]] = []
    for part in parts:
        if part["type"] == "text":
            content.append({"type": "text", "text": part["text"]})
            continue
        source = {
            "type": "base64",
            "media_type": part["media_type"],
            "data": base64.b64encode(part["data"]).decode(),
        }
        kind = "image" if part["media_type"].startswith("image") else "document"
        content.append({"type": kind, "source": source})
    return content


def _google_content(parts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    content: list[dict[str, Any]] = []
    for part in parts:
        if part["type"] == "text":
            content.append({"text": part["text"]})
        else:
            content.append(
                {
                    "inlineData": {
                        "mimeType": part["media_type"],
                        "data": base64.b64encode(part["data"]).decode(),
                    }
                }
            )
    return content


class Model:
    """One model configuration, as the account sealed it: `{provider, model, apiKey, baseUrl?}`."""

    def __init__(self, config: dict[str, Any], http: httpx.Client | None = None) -> None:
        self._config = config
        self._http = http or httpx.Client(timeout=_MODEL_TIMEOUT_SECONDS)
        self._ids = [m.strip() for m in str(config["model"]).split(",") if m.strip()]
        self._resting_until: dict[str, float] = {}

    def generate(
        self, *, system: str, parts: list[dict[str, Any]], schema: dict[str, Any] | None = None
    ) -> Any:
        """Text, or with a schema, the JSON object it asked for. Each model in turn."""
        now = time.monotonic()
        awake = [m for m in self._ids if self._resting_until.get(m, 0) <= now]
        last: ModelError | None = None
        for model in awake or self._ids:
            try:
                return self._call(model, system, parts, schema)
            except ModelError as error:
                if not error.worth_trying_next:
                    raise
                self._resting_until[model] = time.monotonic() + _QUOTA_COOLDOWN_SECONDS
                last = error
        raise last or ModelError(None, "No model is configured.")

    def _call(
        self,
        model: str,
        system: str,
        parts: list[dict[str, Any]],
        schema: dict[str, Any] | None,
    ) -> Any:
        provider = self._config["provider"]
        if provider == "google":
            text = self._google(model, system, parts, schema)
        elif provider == "anthropic":
            return self._anthropic(model, system, parts, schema)
        elif provider in ("openai", "openai-compatible"):
            text = self._openai(model, system, parts, schema)
        else:
            raise ModelError(400, f"Unknown model provider: {provider}")
        if schema is None:
            return text
        try:
            return json.loads(text)
        except ValueError as error:
            raise ModelError(400, "The model didn't return valid JSON.") from error

    def _post(self, url: str, headers: dict[str, str], body: dict[str, Any]) -> Any:
        try:
            response = self._http.post(url, headers=headers, json=body)
        except httpx.HTTPError as error:
            raise ModelError(None, f"Couldn't reach the model: {error}") from error
        if response.is_error:
            raise ModelError(response.status_code, f"The model answered {response.status_code}.")
        return response.json()

    def _openai(
        self,
        model: str,
        system: str,
        parts: list[dict[str, Any]],
        schema: dict[str, Any] | None,
    ) -> str:
        compatible = self._config["provider"] == "openai-compatible"
        base = self._config.get("baseUrl")
        if compatible and not base:
            raise ModelError(400, "An OpenAI-compatible provider needs a base URL.")
        body: dict[str, Any] = {"model": model}
        if schema and compatible:
            # Not every compatible server takes a schema, but they all take "answer in JSON".
            system = f"{system}\n\nAnswer with JSON matching this schema:\n{json.dumps(schema)}"
            body["response_format"] = {"type": "json_object"}
        elif schema:
            body["response_format"] = {
                "type": "json_schema",
                "json_schema": {"name": "output", "schema": schema, "strict": True},
            }
        body["messages"] = [
            {"role": "system", "content": system},
            {"role": "user", "content": _openai_content(parts)},
        ]
        answer = self._post(
            f"{(base or 'https://api.openai.com/v1').rstrip('/')}/chat/completions",
            {"authorization": f"Bearer {self._config['apiKey']}"},
            body,
        )
        return answer["choices"][0]["message"].get("content") or ""

    def _anthropic(
        self,
        model: str,
        system: str,
        parts: list[dict[str, Any]],
        schema: dict[str, Any] | None,
    ) -> Any:
        body: dict[str, Any] = {
            "model": model,
            "max_tokens": _ANTHROPIC_MAX_TOKENS,
            "system": system,
            "messages": [{"role": "user", "content": _anthropic_content(parts)}],
        }
        if schema:
            body["tools"] = [{"name": "output", "input_schema": schema}]
            body["tool_choice"] = {"type": "tool", "name": "output"}
        answer = self._post(
            "https://api.anthropic.com/v1/messages",
            {"x-api-key": self._config["apiKey"], "anthropic-version": "2023-06-01"},
            body,
        )
        blocks = answer.get("content", [])
        if schema:
            for block in blocks:
                if block.get("type") == "tool_use":
                    return block["input"]
            raise ModelError(400, "The model didn't return the structure it was asked for.")
        return "".join(block.get("text", "") for block in blocks if block.get("type") == "text")

    def _google(
        self,
        model: str,
        system: str,
        parts: list[dict[str, Any]],
        schema: dict[str, Any] | None,
    ) -> str:
        body: dict[str, Any] = {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": _google_content(parts)}],
        }
        if schema:
            body["generationConfig"] = {
                "responseMimeType": "application/json",
                "responseSchema": _without_additional(schema),
            }
        answer = self._post(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
            {"x-goog-api-key": self._config["apiKey"]},
            body,
        )
        candidates = answer.get("candidates") or []
        if not candidates:
            raise ModelError(400, "The model returned nothing.")
        return "".join(p.get("text", "") for p in candidates[0].get("content", {}).get("parts", []))

    def close(self) -> None:
        self._http.close()


def _document(url: str) -> dict[str, Any]:
    """Bytes behind a URL: decoded in place for a data URL, fetched for anything else."""
    inline = _DATA_URL.match(url)
    if inline:
        body = inline.group(3)
        return {
            "media_type": inline.group(1) or "application/octet-stream",
            "data": base64.b64decode(body) if inline.group(2) else unquote(body).encode(),
        }
    with httpx.Client(timeout=_MODEL_TIMEOUT_SECONDS, follow_redirects=True) as http:
        response = http.get(url)
    response.raise_for_status()
    return {
        "media_type": response.headers.get("content-type", "").split(";")[0],
        "data": response.content,
    }


def _attachment(part: dict[str, Any]) -> dict[str, Any]:
    kind = part["type"]
    if kind == "text":
        return {"type": "text", "text": part["text"]}
    document = _document(part[kind]["url"])
    if kind == "image_url":
        return {
            "type": "file",
            "data": document["data"],
            "media_type": document["media_type"] or "image/png",
        }
    if kind == "pdf_url":
        return {"type": "file", "data": document["data"], "media_type": "application/pdf"}
    return {"type": "text", "text": document["data"].decode()}


def _conversation_parts(messages: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The conversation as one user turn: speakers labelled in the text, attachments alongside."""
    parts: list[dict[str, Any]] = []
    for message in messages:
        speaker = (
            f"{message['role']} ({message['name']})" if message.get("name") else message["role"]
        )
        if isinstance(message["content"], str):
            parts.append({"type": "text", "text": f"{speaker}: {message['content']}"})
            continue
        parts.append({"type": "text", "text": f"{speaker}:"})
        for part in message["content"]:
            parts.append(_attachment(part))
    return parts


def _category_list(categories: list[dict[str, Any]] | None) -> str:
    listed = categories or [{"name": name} for name in PROMPTS["DEFAULT_CATEGORIES"]]
    return "\n".join(
        f"{c['name']}: {c['description']}" if c.get("description") else c["name"] for c in listed
    )


def extract_memories(
    model: Model,
    *,
    messages: list[dict[str, Any]],
    known: list[str],
    instructions: str | None,
    categories: list[dict[str, Any]] | None,
    observed_at: str,
    agent_scoped: bool,
) -> list[dict[str, Any]]:
    """One model call: a conversation in, the facts worth keeping out."""
    known_text = "\n".join(f"- {text}" for text in known) if known else "(nothing yet)"
    sections = [
        f"Observation date: {observed_at[:10]}",
        f"Categories:\n{_category_list(categories)}",
        f"Already known:\n{known_text}",
    ]
    if instructions:
        sections.append(f"Custom instructions:\n{instructions}")
    sections.append("Conversation:")
    system = PROMPTS["EXTRACTION_SYSTEM"] + (PROMPTS["AGENT_SCOPE_SUFFIX"] if agent_scoped else "")
    output = model.generate(
        system=system,
        parts=[
            {"type": "text", "text": "\n\n".join(sections)},
            *_conversation_parts(messages),
        ],
        schema=_EXTRACTION,
    )
    return [memory for memory in output["memories"] if memory["text"].strip()]


def procedural_record(
    model: Model, messages: list[dict[str, Any]], prompt: str | None = None
) -> str:
    """An agent's working record of a conversation, stored as one memory."""
    text = model.generate(
        system=prompt or PROMPTS["PROCEDURAL_SYSTEM"], parts=_conversation_parts(messages)
    )
    if not text.strip():
        raise ModelError(400, "The model returned an empty record.")
    return text.strip()


def summarize_memories(model: Model, texts: list[str]) -> str:
    text = model.generate(
        system=PROMPTS["SUMMARY_SYSTEM"],
        parts=[{"type": "text", "text": "\n".join(f"- {memory}" for memory in texts)}],
    )
    return text.strip()


def rerank_texts(model: Model, query: str, texts: list[str]) -> list[float]:
    """One relevance score per text, in order."""
    listed = "\n".join(f"[{i}] {text}" for i, text in enumerate(texts))
    output = model.generate(
        system=PROMPTS["RERANK_SYSTEM"],
        parts=[
            {
                "type": "text",
                "text": f"Query: {query}\n\n{listed}\n\nGive exactly {len(texts)} scores, in order.",
            }
        ],
        schema=_RELEVANCE,
    )
    if len(output["scores"]) != len(texts):
        raise ModelError(400, "Wrong number of scores.")
    return [min(1.0, max(0.0, float(score))) for score in output["scores"]]


def generate_instructions(model: Model, use_case: str) -> dict[str, str]:
    return model.generate(
        system=PROMPTS["INSTRUCTIONS_SYSTEM"],
        parts=[{"type": "text", "text": use_case}],
        schema=_INSTRUCTIONS,
    )
