# Generated from ../_async by scripts/unasync.py. Edit that, not this.
"""Memories, in the same verbs in both modes.

Assisted namespaces go through the API, which can read them. Private ones run entirely here: only ids
and ciphertext reach MemDot.
"""

from __future__ import annotations

import base64
import builtins
import json
import logging
import re
import time
from datetime import datetime, timezone
from typing import Any

from .. import crypto
from .._concurrency import sleep
from ..embedder import Embedder, LocalEmbedder
from ..engine import FilterError, normalize_messages, parse_filter, parse_memory_import
from ..errors import ConflictError, MemDotError, NotFoundError, ValidationError
from ..models import (
    AddedMemory,
    AddResult,
    Entity,
    HistoryEvent,
    Memory,
    MemoryEvent,
    MemoryPage,
    Namespace,
    ScoredMemory,
)
from . import llm
from .context import Context
from .private_memory import PrivateDeps, PrivateNamespace
from .simple import Jobs
from .spaces import Folders, Spaces, open_text, to_base64
from .transport import seg

log = logging.getLogger("memdot")

_DEFAULT_TOP_K = 10
_DEFAULT_THRESHOLD = 0.1
_DEFAULT_PAGE = 50
_EVENT_POLL_SECONDS = 0.5
#: How long `add` waits for a memory to become searchable before returning what it knows.
_INDEX_TIMEOUT_SECONDS = 120.0
#: Writes before a Private namespace's index is worth saving again.
_SNAPSHOT_EVERY = 100
_DATE_ONLY = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_SCOPE_REQUIRED = "Give at least one of user_id, agent_id or run_id."


def _iso(moment: datetime) -> str:
    moment = moment.astimezone(timezone.utc)
    return f"{moment.strftime('%Y-%m-%dT%H:%M:%S')}.{moment.microsecond // 1000:03d}Z"


def _moment(value: int | float | str) -> datetime:
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, timezone.utc)
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _expiry(value: str | None) -> str | None:
    if not value:
        return value
    return f"{value}T23:59:59.999Z" if _DATE_ONLY.match(value) else _iso(_moment(value))


def _parse_filters(filters: dict[str, Any] | None) -> dict[str, Any] | None:
    if not filters:
        return None
    try:
        return parse_filter(filters)
    except FilterError as error:
        raise ValidationError(400, "BAD_FILTER", str(error)) from error


def _from_wire(raw: dict[str, Any]) -> dict[str, Any]:
    return {**raw, "mode": "assisted"}


def _from_entry(entry: dict[str, Any], namespace_id: str) -> dict[str, Any]:
    source = entry.get("source")
    return {
        "id": entry["id"],
        "memory": entry["text"],
        "namespace_id": namespace_id,
        "user_id": entry.get("userId"),
        "agent_id": entry.get("agentId"),
        "run_id": entry.get("runId"),
        "metadata": entry.get("metadata"),
        "categories": entry.get("categories"),
        "memory_type": entry.get("memoryType"),
        "attributed_to": entry.get("attributedTo"),
        "source": {
            "kind": source["kind"],
            "object_id": source.get("objectId"),
            "label": source.get("label"),
        }
        if source
        else None,
        "raw": entry.get("raw", False),
        "immutable": entry.get("immutable", False),
        "version": entry["version"],
        "feedback": None,
        "expiration_date": entry.get("expiresAt"),
        "occurred_at": entry.get("occurredAt"),
        "created_at": entry["createdAt"],
        "updated_at": entry["updatedAt"],
        "segment": None,
        "mode": "private",
    }


def _scored(fields: dict[str, Any], hit: dict[str, Any]) -> ScoredMemory:
    breakdown = hit.get("score_breakdown") or {
        "semantic": hit.get("semantic", 0),
        "bm25": hit.get("bm25", 0),
        "entity": hit.get("entity", 0),
    }
    rerank = hit.get("rerank_score", hit.get("rerankScore"))
    return ScoredMemory.model_validate(
        {**fields, "score": hit["score"], "score_breakdown": breakdown, "rerank_score": rerank}
    )


class Memories:
    def __init__(
        self,
        ctx: Context,
        spaces: Spaces,
        folders: Folders,
        jobs: Jobs,
        embedder: Embedder | None = None,
        default_namespace: str | None = None,
    ) -> None:
        #: Where a call that names no namespace goes. Without it, the API would pick an Assisted
        #: one, so text meant for a Private namespace would have already left this device.
        self._default_namespace = default_namespace
        self._ctx = ctx
        self._spaces = spaces
        self._folders = folders
        self._jobs = jobs
        self._embedder = embedder
        self._private: dict[str, PrivateNamespace] = {}
        self._namespace_rows: dict[str, dict[str, Any]] = {}
        self._private_settings: Any = ...
        self._private_model_client: llm.Model | None = None
        ctx.vault.subscribe(self._on_lock_change)

    def _on_lock_change(self) -> None:
        if not self._ctx.vault.unlocked:
            self._private.clear()
            self._private_settings = ...
            self._private_model_client = None

    def close(self) -> None:
        if self._private_model_client is not None:
            self._private_model_client.close()
            self._private_model_client = None

    def _local_embedder(self) -> Embedder:
        if self._embedder is None:
            self._embedder = LocalEmbedder()
        return self._embedder

    # ── Namespaces ───────────────────────────────────────────────────────────────────────────

    def _raw_namespaces(self, space_id: str | None = None) -> builtins.list[dict[str, Any]]:
        answer = self._ctx.transport.json("GET", "/v1/namespaces", params={"space_id": space_id})
        for row in answer["results"]:
            self._namespace_rows[row["id"]] = row
        return answer["results"]

    def namespaces(self, space_id: str | None = None) -> builtins.list[Namespace]:
        rows = []
        for row in self._raw_namespaces(space_id):
            self._ctx.ensure_keys(row["space_id"], row["key_epoch"])
            vault = self._ctx.vault
            identities = (
                vault.owned_identities(row["space_id"], row["key_epoch"])
                if vault.holds_keys
                else []
            )
            rows.append(
                Namespace(
                    id=row["id"],
                    space_id=row["space_id"],
                    name=open_text(row.get("encrypted_name"), identities),
                    mode=row["mode"],
                    total_memories=row["total_memories"],
                    segments=row["segments"],
                    last_write=row.get("last_write"),
                    created_at=row.get("created_at"),
                )
            )
        return rows

    def create_namespace(self, *, space_id: str, name: str, mode: str) -> Namespace:
        """A namespace is a folder in memory mode. Its mode is fixed: changing it means a new one."""
        folder = self._folders.create(space_id, name, memory_mode=mode)
        return Namespace(
            id=folder.id,
            space_id=folder.space_id,
            name=name,
            mode=mode,
            created_at=folder.created_at,
        )

    def _namespace_row(self, namespace_id: str) -> dict[str, Any]:
        row = self._namespace_rows.get(namespace_id)
        if row:
            return row
        self._raw_namespaces()
        row = self._namespace_rows.get(namespace_id)
        if not row:
            raise NotFoundError(404, "NOT_FOUND", "Namespace not found.")
        return row

    def _private_of(self, row: dict[str, Any]) -> PrivateNamespace:
        held = self._private.get(row["id"])
        if not held:
            held = PrivateNamespace(
                PrivateDeps(
                    ctx=self._ctx,
                    spaces=self._spaces,
                    jobs=self._jobs,
                    embedder=self._local_embedder,
                    model=self._private_model,
                    settings=self._open_settings,
                ),
                row["id"],
                row["space_id"],
            )
            self._private[row["id"]] = held
        return held

    def _route(self, namespace_id: str | None) -> PrivateNamespace | None:
        """Private, or Assisted handled by the API. No id: the API picks the caller's default."""
        if not namespace_id:
            return None
        row = self._namespace_row(namespace_id)
        return self._private_of(row) if row["mode"] == "private" else None

    def settings(self, namespace_id: str) -> dict[str, Any]:
        opened = self._open_settings(namespace_id)
        return {
            "custom_instructions": opened.get("instructions"),
            "categories": opened.get("categories"),
        }

    def _open_settings(self, namespace_id: str) -> dict[str, Any]:
        row = self._ctx.transport.json("GET", f"/v1/namespaces/{seg(namespace_id)}/settings")
        if row.get("sealed"):
            text = crypto.open_with(
                base64.b64decode(row["sealed"]), self._ctx.vault.identity(), "the settings"
            )
            return json.loads(text)
        return {"instructions": row.get("custom_instructions"), "categories": row.get("categories")}

    def set_settings(
        self,
        namespace_id: str,
        *,
        custom_instructions: str | None,
        categories: builtins.list[dict[str, Any]] | None,
    ) -> None:
        """Assisted: the server reads these to extract. Private: sealed here, and only kept there."""
        row = self._namespace_row(namespace_id)
        if row["mode"] == "private":
            settings = {"instructions": custom_instructions, "categories": categories}
            sealed = crypto.seal_to(crypto.dumps(settings), [self._ctx.vault.recipient()])
            body: dict[str, Any] = {"sealed": to_base64(sealed)}
        else:
            body = {"custom_instructions": custom_instructions, "categories": categories}
        self._ctx.transport.json("PUT", f"/v1/namespaces/{seg(namespace_id)}/settings", body)

    # ── The model Private namespaces use ─────────────────────────────────────────────────────

    def _load_private_settings(self) -> dict[str, Any] | None:
        if self._private_settings is not ...:
            return self._private_settings
        if not self._ctx.vault.unlocked:
            return None
        config = self._ctx.transport.json("GET", "/v1/configure")
        sealed = config.get("private_sealed")
        self._private_settings = (
            json.loads(
                crypto.open_with(
                    base64.b64decode(sealed), self._ctx.vault.identity(), "your private settings"
                )
            )
            if sealed
            else None
        )
        return self._private_settings

    def _private_llm(self) -> dict[str, Any] | None:
        return ((self._load_private_settings()) or {}).get("llm")

    def _private_model(self) -> llm.Model | None:
        config = self._private_llm()
        if not config:
            return None
        if self._private_model_client is None:
            self._private_model_client = llm.Model(config)
        return self._private_model_client

    def private_model(self) -> dict[str, Any] | None:
        """Whether a Private model is set, without showing its key."""
        config = self._private_llm()
        if not config:
            return None
        return {k: config[k] for k in ("provider", "model", "baseUrl") if config.get(k)}

    def set_private_model(self, config: dict[str, Any] | None) -> None:
        """Sets the model Private namespaces extract with: `{provider, model, apiKey, baseUrl?}`.

        The key is sealed here to this account's own key before it's saved, so MemDot can't read it,
        and every device you unlock can.
        """
        settings = {"llm": config} if config else {}
        sealed = (
            to_base64(crypto.seal_to(crypto.dumps(settings), [self._ctx.vault.recipient()]))
            if config
            else None
        )
        self._ctx.transport.json("PUT", "/v1/configure", {"private_sealed": sealed})
        self._private_settings = settings if config else None
        self._private_model_client = None

    def configuration(self) -> Any:
        """The models Assisted namespaces use. Keys are never returned."""
        return self._ctx.transport.json("GET", "/v1/configure")

    def set_models(self, change: dict[str, Any]) -> Any:
        """Chooses this account's models for Assisted namespaces. None goes back to MemDot's."""
        return self._ctx.transport.json("PUT", "/v1/configure", change)

    def test_models(self) -> Any:
        """Sends one short request to each configured model."""
        return self._ctx.transport.json("POST", "/v1/configure/test")

    def generate_instructions(
        self, use_case: str, *, namespace_id: str | None = None
    ) -> dict[str, Any]:
        """Drafts custom instructions from a description of what you're building."""
        row = self._namespace_row(namespace_id) if namespace_id else None
        if row and row["mode"] == "private":
            model = self._private_model()
            if not model:
                raise ConflictError(409, "MODEL_REQUIRED", "Set a model for Private memory first.")
            return llm.generate_instructions(model, use_case)
        return self._ctx.transport.json("POST", "/v1/generate-instructions", {"use_case": use_case})

    # ── Remember ─────────────────────────────────────────────────────────────────────────────

    def add(
        self,
        messages: str | dict[str, Any] | builtins.list[dict[str, Any]],
        *,
        user_id: str | None = None,
        agent_id: str | None = None,
        run_id: str | None = None,
        namespace_id: str | None = None,
        metadata: dict[str, Any] | None = None,
        expiration_date: Any = ...,
        timestamp: int | float | str | None = None,
        infer: bool = True,
        memory_type: str | None = None,
        prompt: str | None = None,
        categories: builtins.list[dict[str, Any]] | None = None,
        immutable: bool = False,
        source: dict[str, str] | None = None,
        wait: str | bool = "indexed",
    ) -> AddResult:
        """Remembers a string or chat messages. At least one of the three ids is required.

        `wait`: "indexed" returns once it's searchable (default), "chain" once it's finalized on
        Portaldot V3, and False at once with the event to follow.
        """
        if not (user_id or agent_id or run_id):
            raise ValidationError(400, "SCOPE_REQUIRED", _SCOPE_REQUIRED)
        namespace_id = namespace_id or self._default_namespace
        normalized = normalize_messages(messages)
        held = self._route(namespace_id)
        if held:
            written = held.add(
                messages=normalized,
                user_id=user_id,
                agent_id=agent_id,
                run_id=run_id,
                metadata=metadata,
                expires_at=None if expiration_date is ... else _expiry(expiration_date),
                occurred_at=_iso(_moment(timestamp)) if timestamp is not None else None,
                infer=infer,
                procedural=memory_type == "procedural_memory",
                prompt=prompt,
                categories=categories,
                immutable=immutable,
                source=_private_source(source),
                wait=wait == "chain",
            )
            if held.unsaved >= _SNAPSHOT_EVERY:
                try:
                    held.save_index(wait=False)
                except MemDotError as error:
                    log.warning("index snapshot skipped: %s", error)
            return AddResult(
                event_id=written["job_id"],
                namespace_id=held.id,
                status="RUNNING" if written["job_id"] else "SUCCEEDED",
                results=[
                    AddedMemory(id=entry["id"], memory=entry["text"], event="ADD")
                    for entry in written["entries"]
                ],
                duplicates=written["duplicates"],
                note=written["note"],
            )

        body: dict[str, Any] = {"messages": normalized, "infer": infer}
        optional = {
            "namespace_id": namespace_id,
            "user_id": user_id,
            "agent_id": agent_id,
            "run_id": run_id,
            "metadata": metadata,
            "timestamp": timestamp,
            "memory_type": memory_type,
            "prompt": prompt,
        }
        body.update({key: value for key, value in optional.items() if value not in (None, "")})
        if expiration_date is not ...:
            body["expiration_date"] = expiration_date
        if categories:
            body["custom_categories"] = [
                {category["name"]: category.get("description") or ""} for category in categories
            ]
        if immutable:
            body["immutable"] = True
        if source:
            body["source"] = {
                key: value
                for key, value in (
                    ("object_id", source.get("object_id")),
                    ("label", source.get("label")),
                )
                if value
            }
        accepted = self._ctx.transport.json("POST", "/v1/memories", body)
        if wait is False:
            return AddResult(
                event_id=accepted["event_id"],
                namespace_id=accepted["namespace_id"],
                status=accepted["status"],
            )
        event = self.wait_for_event(accepted["event_id"], "chain" if wait == "chain" else "indexed")
        return AddResult(
            event_id=accepted["event_id"],
            namespace_id=accepted["namespace_id"],
            status=event.status,
            results=event.results,
            duplicates=event.duplicates,
            note=event.note,
        )

    def event(self, event_id: str) -> MemoryEvent:
        return MemoryEvent.model_validate(
            self._ctx.transport.json("GET", f"/v1/memories/events/{seg(event_id)}")
        )

    def events(self, *, limit: int | None = None, cursor: str | None = None) -> Any:
        return self._ctx.transport.json(
            "GET", "/v1/memories/events", params={"limit": limit, "cursor": cursor}
        )

    def wait_for_event(self, event_id: str, until: str = "indexed") -> MemoryEvent:
        """Waits until a write is searchable or, if asked, finalized on chain."""
        deadline = time.monotonic() + _INDEX_TIMEOUT_SECONDS
        while True:
            event = self.event(event_id)
            if event.status == "FAILED":
                raise MemDotError(422, "MEMORY_FAILED", event.error or "The write failed.")
            if event.status == "SUCCEEDED" or (until == "indexed" and event.indexed):
                return event
            if time.monotonic() > deadline:
                return event
            sleep(_EVENT_POLL_SECONDS)

    # ── Recall ───────────────────────────────────────────────────────────────────────────────

    def search(
        self,
        query: str,
        *,
        namespace_id: str | None = None,
        filters: dict[str, Any] | None = None,
        top_k: int = _DEFAULT_TOP_K,
        threshold: float = _DEFAULT_THRESHOLD,
        mode: str = "hybrid",
        rerank: bool = False,
        show_expired: bool = False,
        reference_date: int | float | str | None = None,
    ) -> builtins.list[ScoredMemory]:
        namespace_id = namespace_id or self._default_namespace
        held = self._route(namespace_id)
        if held:
            hits = held.search(
                query=query,
                limit=top_k,
                threshold=threshold,
                mode=mode,
                filter_node=_parse_filters(filters),
                show_expired=show_expired,
                as_of=_moment(reference_date) if reference_date is not None else None,
                rerank_hits=rerank,
            )
            return [_scored(_from_entry(hit, held.id), hit) for hit in hits]
        body: dict[str, Any] = {
            "query": query,
            "top_k": top_k,
            "threshold": threshold,
            "mode": mode,
            "rerank": rerank,
            "show_expired": show_expired,
        }
        if namespace_id:
            body["namespace_id"] = namespace_id
        if filters:
            body["filters"] = filters
        if reference_date is not None:
            body["reference_date"] = reference_date
        answer = self._ctx.transport.json("POST", "/v1/memories/search", body)
        return [_scored(_from_wire(raw), raw) for raw in answer["results"]]

    def list(
        self,
        *,
        namespace_id: str | None = None,
        filters: dict[str, Any] | None = None,
        show_expired: bool = False,
        cursor: str | None = None,
        page_size: int = _DEFAULT_PAGE,
    ) -> MemoryPage:
        namespace_id = namespace_id or self._default_namespace
        held = self._route(namespace_id)
        if held:
            entries = held.list(filter_node=_parse_filters(filters), show_expired=show_expired)
            start = int(cursor) if cursor else 0
            page = entries[start : start + page_size]
            after = start + page_size
            return MemoryPage(
                results=[Memory.model_validate(_from_entry(e, held.id)) for e in page],
                count=len(entries),
                next_cursor=str(after) if after < len(entries) else None,
            )
        body: dict[str, Any] = {"page_size": page_size, "show_expired": show_expired}
        if namespace_id:
            body["namespace_id"] = namespace_id
        if filters:
            body["filters"] = filters
        if cursor:
            body["cursor"] = cursor
        answer = self._ctx.transport.json("POST", "/v1/memories/list", body)
        return MemoryPage(
            results=[Memory.model_validate(_from_wire(raw)) for raw in answer["results"]],
            count=answer["count"],
            next_cursor=answer.get("next_cursor"),
        )

    def _private_holding(self, error: MemDotError) -> PrivateNamespace | None:
        """The Private namespace that holds an id, known from an API refusal when none was given."""
        details = error.details if isinstance(error.details, dict) else {}
        if error.code != "PRIVATE_NAMESPACE" or not details.get("namespaceId"):
            return None
        return self._route(details["namespaceId"])

    def get(self, memory_id: str) -> Memory:
        try:
            raw = self._ctx.transport.json("GET", f"/v1/memories/{seg(memory_id)}")
            return Memory.model_validate(_from_wire(raw))
        except MemDotError as error:
            held = self._private_holding(error)
            if not held:
                raise
            entry = held.get(memory_id)
            if not entry:
                raise NotFoundError(404, "NOT_FOUND", "Memory not found.") from error
            return Memory.model_validate(_from_entry(entry, held.id))

    def _holder_of(self, memory_id: str) -> PrivateNamespace | None:
        """The Private namespace holding a memory, or None if it's Assisted.

        Asked before anything is sent: text for a Private memory must never leave this device, not
        even to be refused.
        """
        for held in self._private.values():
            if held.holds(memory_id):
                return held
        try:
            self._ctx.transport.json("GET", f"/v1/memories/{seg(memory_id)}")
            return None
        except MemDotError as error:
            held = self._private_holding(error)
            if not held:
                raise
            return held

    def update(
        self,
        memory_id: str,
        *,
        text: str | None = None,
        metadata: dict[str, Any] | None = None,
        expiration_date: Any = ...,
        wait: bool = False,
    ) -> Memory:
        held = self._holder_of(memory_id)
        if held:
            next_entry = held.update(
                memory_id,
                text=text,
                metadata=metadata,
                expires_at=... if expiration_date is ... else _expiry(expiration_date),
                wait=wait,
            )
            return Memory.model_validate(_from_entry(next_entry, held.id))
        body: dict[str, Any] = {}
        if text is not None:
            body["text"] = text
        if metadata:
            body["metadata"] = metadata
        if expiration_date is not ...:
            body["expiration_date"] = expiration_date
        raw = self._ctx.transport.json("PUT", f"/v1/memories/{seg(memory_id)}", body)
        return Memory.model_validate(_from_wire(raw))

    def delete(self, memory_id: str) -> None:
        """Forgets one memory: out of search and lists at once, in both modes."""
        self._ctx.transport.json("DELETE", f"/v1/memories/{seg(memory_id)}")
        for held in self._private.values():
            held.forget([memory_id])

    def delete_all(
        self,
        *,
        user_id: str | None = None,
        agent_id: str | None = None,
        run_id: str | None = None,
        namespace_id: str | None = None,
    ) -> int:
        """Forgets everything in a scope and says how many. `"*"` matches every value of one."""
        if not (user_id or agent_id or run_id):
            raise ValidationError(400, "SCOPE_REQUIRED", _SCOPE_REQUIRED)
        namespace_id = namespace_id or self._default_namespace
        held = self._route(namespace_id)
        scope = {"user_id": user_id, "agent_id": agent_id, "run_id": run_id}
        if held:
            filters = {key: value for key, value in scope.items() if value}
            entries = held.list(filter_node=_parse_filters(filters), show_expired=True)
            self.batch_delete([entry["id"] for entry in entries])
            return len(entries)
        answer = self._ctx.transport.json(
            "DELETE", "/v1/memories", params={"namespace_id": namespace_id, **scope}
        )
        return answer["deleted"]

    def history(self, memory_id: str) -> builtins.list[HistoryEvent]:
        try:
            answer = self._ctx.transport.json("GET", f"/v1/memories/{seg(memory_id)}/history")
            return [
                HistoryEvent(
                    event=row["event"],
                    old_memory=row.get("old_memory"),
                    new_memory=row.get("new_memory"),
                    actor=row.get("actor"),
                    created_at=row.get("created_at"),
                )
                for row in answer["results"]
            ]
        except MemDotError as error:
            held = self._private_holding(error)
            if not held:
                raise
            entry = held.get(memory_id)
            return [
                HistoryEvent(
                    event=change["event"],
                    old_memory=change.get("previous"),
                    new_memory=change.get("text"),
                    actor=change.get("actor"),
                    created_at=change.get("at"),
                )
                for change in (entry or {}).get("history") or []
            ]

    def batch_update(self, memories: builtins.list[dict[str, Any]]) -> None:
        """Each of `{id, text?, metadata?}`."""
        assisted = []
        for memory in memories:
            held = self._holder_of(memory["id"])
            if held:
                held.update(memory["id"], text=memory.get("text"), metadata=memory.get("metadata"))
            else:
                assisted.append(memory)
        if assisted:
            rows = []
            for memory in assisted:
                row: dict[str, Any] = {"memory_id": memory["id"]}
                if memory.get("text") is not None:
                    row["text"] = memory["text"]
                if memory.get("metadata"):
                    row["metadata"] = memory["metadata"]
                rows.append(row)
            self._ctx.transport.json("PUT", "/v1/batch", {"memories": rows})

    def batch_delete(self, ids: builtins.list[str]) -> None:
        if not ids:
            return
        self._ctx.transport.json(
            "DELETE", "/v1/batch", {"memories": [{"memory_id": memory_id} for memory_id in ids]}
        )
        for held in self._private.values():
            held.forget(ids)

    def feedback(self, memory_id: str, feedback: str | None, reason: str | None = None) -> Any:
        body: dict[str, Any] = {"memory_id": memory_id, "feedback": feedback}
        if reason:
            body["feedback_reason"] = reason
        return self._ctx.transport.json("POST", "/v1/feedback", body)

    def summary(
        self, *, namespace_id: str | None = None, filters: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        namespace_id = namespace_id or self._default_namespace
        held = self._route(namespace_id)
        if held:
            return {"summary": held.summary(filter_node=_parse_filters(filters))}
        body: dict[str, Any] = {}
        if namespace_id:
            body["namespace_id"] = namespace_id
        if filters:
            body["filters"] = filters
        return self._ctx.transport.json("POST", "/v1/memories/summary", body)

    # ── Entities ─────────────────────────────────────────────────────────────────────────────

    def entities(self, *, namespace_id: str | None = None) -> builtins.list[Entity]:
        namespace_id = namespace_id or self._default_namespace
        held = self._route(namespace_id)
        if held:
            totals: dict[str, Entity] = {}
            for entry in held.list(show_expired=True):
                for kind, key in (("user", "userId"), ("agent", "agentId"), ("run", "runId")):
                    value = entry.get(key)
                    if not value:
                        continue
                    entity = totals.get(f"{kind}:{value}")
                    if not entity:
                        totals[f"{kind}:{value}"] = Entity(
                            id=value,
                            type=kind,
                            total_memories=1,
                            created_at=entry["createdAt"],
                            updated_at=entry["updatedAt"],
                            namespace_id=held.id,
                        )
                        continue
                    entity.total_memories += 1
                    entity.created_at = min(entity.created_at or "", entry["createdAt"])
                    entity.updated_at = max(entity.updated_at or "", entry["updatedAt"])
            return sorted(totals.values(), key=lambda e: e.updated_at or "", reverse=True)
        answer = self._ctx.transport.json(
            "GET", "/v1/entities", params={"namespace_id": namespace_id}
        )
        return [
            Entity(
                id=row["id"],
                type=row["type"],
                total_memories=row["total_memories"],
                created_at=row.get("created_at"),
                updated_at=row.get("updated_at"),
                namespace_id=row.get("namespace_id"),
            )
            for row in answer["results"]
        ]

    def delete_entity(self, kind: str, entity_id: str, *, namespace_id: str | None = None) -> int:
        """Forgets a user, agent or run, and every memory it holds."""
        namespace_id = namespace_id or self._default_namespace
        held = self._route(namespace_id)
        if held:
            key = {"user": "user_id", "agent": "agent_id", "run": "run_id"}[kind]
            return self.delete_all(namespace_id=held.id, **{key: entity_id})
        answer = self._ctx.transport.json(
            "DELETE",
            f"/v1/entities/{seg(kind)}/{seg(entity_id)}",
            params={"namespace_id": namespace_id},
        )
        return answer["deleted"]

    # ── Keeping a namespace healthy ──────────────────────────────────────────────────────────

    def restore(self, namespace_id: str) -> Any:
        """Rebuilds the index from the chain alone.

        Assisted: the server re-reads every segment. Private: this device does, over its own
        connection to V3, and throws away what it held first.
        """
        held = self._route(namespace_id)
        if held:
            return held.restore()
        accepted = self._ctx.transport.json("POST", f"/v1/namespaces/{seg(namespace_id)}/restore")
        return self.wait_for_event(accepted["event_id"], "chain")

    def reset(self, namespace_id: str) -> None:
        """Forgets everything in a namespace."""
        self._ctx.transport.json("POST", f"/v1/namespaces/{seg(namespace_id)}/reset")
        self._private.pop(namespace_id, None)

    def compact(self, namespace_id: str) -> Any:
        """Merges mostly dead segments. Automatic for Assisted; Private runs it here, when asked."""
        held = self._route(namespace_id)
        if held:
            return held.compact()
        return self._ctx.transport.json("POST", f"/v1/namespaces/{seg(namespace_id)}/compact")

    def save_index(self, namespace_id: str) -> str:
        """Private: stores the index, encrypted, so another device can start without embedding."""
        held = self._route(namespace_id)
        if not held:
            raise ValidationError(400, "NOT_PRIVATE", "Only Private namespaces keep a snapshot.")
        return held.save_index(wait=True)

    # ── Import and export ────────────────────────────────────────────────────────────────────

    def export_memories(self, namespace_id: str) -> builtins.list[dict[str, Any]]:
        """Every memory in a namespace with what's needed to import it elsewhere."""
        held = self._route(namespace_id)
        if held:
            return [
                {
                    "id": entry["id"],
                    "memory": entry["text"],
                    "user_id": entry.get("userId"),
                    "agent_id": entry.get("agentId"),
                    "run_id": entry.get("runId"),
                    "metadata": entry.get("metadata"),
                    "categories": entry.get("categories"),
                    "expiration_date": entry.get("expiresAt"),
                    "created_at": entry["createdAt"],
                    "updated_at": entry["updatedAt"],
                }
                for entry in held.list(show_expired=True)
            ]
        answer = self._ctx.transport.json("GET", f"/v1/namespaces/{seg(namespace_id)}/export")
        return answer["memories"]

    def import_memories(
        self,
        data: Any,
        *,
        namespace_id: str,
        source: str = "import",
        user_id: str | None = None,
    ) -> dict[str, int]:
        """Imports an export file: MemDot's own, or a list or `{results: […]}` from elsewhere.

        Stored as written, no model involved; the same fact in the same scope is dropped.
        """
        held = self._route(namespace_id)
        parsed = parse_memory_import(data)
        if held:
            items = parsed["items"]
            unscoped = [
                item
                for item in items
                if not (item.get("userId") or item.get("agentId") or item.get("runId"))
            ]
            if unscoped and not user_id:
                raise ConflictError(
                    409,
                    "SCOPE_REQUIRED",
                    f"{len(unscoped)} of these memories name no user, agent or run. "
                    "Pass user_id to file them under one.",
                )
            written = held.import_items(
                [
                    item
                    if item.get("userId") or item.get("agentId") or item.get("runId")
                    else {**item, "userId": user_id}
                    for item in items
                ],
                source,
            )
            return {**written, "skipped": parsed["skipped"]}
        body: dict[str, Any] = {"namespace_id": namespace_id, "data": data, "source": source}
        if user_id:
            body["user_id"] = user_id
        accepted = self._ctx.transport.json("POST", "/v1/memories/import", body)
        event = self.wait_for_event(accepted["event_id"], "indexed")
        return {
            "imported": len(event.results),
            "duplicates": event.duplicates,
            "skipped": accepted["skipped"],
        }

    def record_server_segments(self) -> None:
        """Adds memory segments to the public registry, grouped per space into one record each."""
        if not self._ctx.vault.unlocked:
            return
        answer = self._ctx.transport.json("GET", "/v1/namespaces/unrecorded-segments")
        results = answer["results"]
        if not results:
            return
        by_space: dict[str, builtins.list[dict[str, Any]]] = {}
        for segment in results:
            by_space.setdefault(segment["space_id"], []).append(segment)
        recorded: builtins.list[str] = []
        for space_id, segments in by_space.items():
            if self._ctx.registry.add_objects(
                space_id,
                [
                    {"kind": "segment", "root_cid": segment["cid"], "size": segment["size"]}
                    for segment in segments
                ],
            ):
                recorded.extend(segment["id"] for segment in segments)
        # What wasn't recorded stays unrecorded, for an unlock that can.
        if recorded:
            self._ctx.transport.json("POST", "/v1/namespaces/recorded-segments", {"ids": recorded})


def _private_source(source: dict[str, str] | None) -> dict[str, str]:
    if not source:
        return {"kind": "conversation"}
    shaped = {"kind": "file" if source.get("object_id") else "conversation"}
    if source.get("object_id"):
        shaped["objectId"] = source["object_id"]
    if source.get("label"):
        shaped["label"] = source["label"]
    return shaped
