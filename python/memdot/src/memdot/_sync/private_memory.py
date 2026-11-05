# Generated from ../_async by scripts/unasync.py. Edit that, not this.
"""A Private namespace, held in memory on this device: only ids and ciphertext reach MemDot.

Segments are read back and opened here; the index is built here; extraction calls the model with the
account's own key straight from this device.
"""

from __future__ import annotations

import logging
import math
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

from .. import crypto
from .._concurrency import run_direct
from ..crypto import SegmentEntry, WrongKeyError
from ..embedder import Embedder, EmbedderMissing
from ..engine import (
    ENTITY_BOOST,
    LOCAL_EMBEDDING_MODEL,
    LocalIndex,
    candidate_count,
    decode_entry,
    dedupe_key,
    encode_entry,
    entity_candidates,
    is_expired,
    iso_now,
    matches_filter,
    message_text,
    normalize_entity,
    query_term_count,
    rank,
    read_snapshot,
    to_filterable,
    tokenize,
)
from ..engine.filters import parse_instant
from ..errors import ConflictError, MemDotError, NotFoundError
from . import llm
from .chain import NodeError
from .context import Context
from .files import SEGMENT_PACK_BYTES, require_sponsored, store_object
from .simple import Jobs
from .spaces import Spaces
from .transport import seg

log = logging.getLogger("memdot")

#: Nearby memories shown to the model, so it doesn't write the same fact again.
_KNOWN_MEMORIES = 10
#: A namespace past this many segments is worth compacting.
_COMPACT_ABOVE_SEGMENTS = 32
#: Texts embedded in one go.
_EMBED_BATCH = 64
_QUERY_FOR_NEARBY_CHARS = 2_000


@dataclass
class PrivateDeps:
    ctx: Context
    spaces: Spaces
    jobs: Jobs
    embedder: Callable[[], Embedder]
    #: The model Private extraction uses, with the account's own key.
    model: Callable[[], llm.Model | None]
    settings: Callable[[str], dict[str, Any]]


class PrivateNamespace:
    def __init__(self, deps: PrivateDeps, namespace_id: str, space_id: str) -> None:
        self._deps = deps
        self.id = namespace_id
        self.space_id = space_id
        self._entries: dict[str, dict[str, Any]] = {}
        #: Already opened: segments never change, so each is read once.
        self._opened: dict[str, list[dict[str, Any]]] = {}
        self._index: LocalIndex | None = None
        self._dirty = 0
        self._warned = False

    @property
    def _ctx(self) -> Context:
        return self._deps.ctx

    def ensure_loaded(self) -> None:
        """Catches up with what other devices wrote."""
        self._sync()

    def _state(self) -> dict[str, Any]:
        return self._ctx.transport.json("GET", f"/v1/namespaces/{seg(self.id)}/private")

    def _identities(self) -> list[str]:
        space = self._deps.spaces.raw(self.space_id)
        return self._ctx.vault.owned_identities(self.space_id, space["keyEpoch"])

    def _sync(self, from_chain: bool = False) -> None:
        if not self._ctx.vault.holds_keys:
            raise MemDotError(423, "LOCKED", "Unlock your account to read a Private namespace.")
        state = self._state()
        identities = self._identities()
        chain = self._ctx.chain() if from_chain else None
        for segment in state["segments"]:
            cid = segment.get("cid")
            if not cid or cid in self._opened:
                continue
            try:
                sealed = chain.bitswap_get(cid) if chain else self._ctx.transport.blob(cid)
            except NodeError as error:
                raise ConflictError(
                    409,
                    "NOT_ON_CHAIN_YET",
                    "A recent write hasn't reached the chain yet, so this can't be rebuilt from "
                    "the chain alone. Try again in a minute.",
                ) from error
            try:
                packed = crypto.open_segment(sealed, identities)
            except WrongKeyError as error:
                if self._ctx.vault.is_agent:
                    raise ConflictError(
                        409,
                        "KEY_BEHIND",
                        "Something here was sealed with a key this agent hasn't received. "
                        "It arrives the next time the owner opens MemDot.",
                    ) from error
                raise
            self._opened[cid] = [decode_entry(entry.data) for entry in packed]

        wanted = {row["id"]: row["version"] for row in state["live"]}
        self._entries.clear()
        for entries in self._opened.values():
            for entry in entries:
                if wanted.get(entry["id"]) == entry["version"]:
                    self._entries[entry["id"]] = entry
        if self._index is None:
            self._build_index(state.get("snapshot"), identities)
            return
        index = self._index
        changed = [e for e in self._entries.values() if index.version(e["id"]) != e["version"]]
        for memory_id in index.ids():
            if memory_id not in self._entries:
                index.remove(memory_id)
        for entry in changed:
            index.put(entry["id"], entry["version"], entry["text"])
        self._embed_into(changed)

    def _new_index(self) -> LocalIndex:
        embedder = self._deps.embedder()
        return LocalIndex(
            embedder.model_id, str(LOCAL_EMBEDDING_MODEL["dtype"]), embedder.dimensions
        )

    def _build_index(self, snapshot: dict[str, Any] | None, identities: list[str]) -> None:
        index = self._new_index()
        vectors = None
        if snapshot and snapshot.get("cid"):
            # A bad snapshot only costs time: everything can be embedded again from the segments.
            try:
                sealed = self._ctx.transport.blob(snapshot["cid"])
                vectors = read_snapshot(
                    crypto.open_with(sealed, identities, "the index snapshot"),
                    model_id=index.model_id,
                    dtype=index.dtype,
                    dimensions=index.dimensions,
                )
            except Exception as error:
                log.warning("index snapshot skipped: %s", error)
        missing = []
        for entry in self._entries.values():
            held = (vectors or {}).get(entry["id"])
            if held and held[0] == entry["version"]:
                index.put(entry["id"], entry["version"], entry["text"], held[1])
            else:
                index.put(entry["id"], entry["version"], entry["text"])
                missing.append(entry)
        self._index = index
        self._embed_into(missing)

    def _embed(self, texts: list[str], purpose: str) -> list[list[float]] | None:
        """Vectors, or None without the local model: everything still works by words."""
        try:
            return run_direct(self._deps.embedder().embed, texts, purpose)
        except EmbedderMissing as error:
            if not self._warned:
                self._warned = True
                log.warning("%s Until then, search goes by words only.", error)
            return None

    def _embed_into(self, entries: list[dict[str, Any]]) -> None:
        for start in range(0, len(entries), _EMBED_BATCH):
            batch = entries[start : start + _EMBED_BATCH]
            vectors = self._embed([entry["text"] for entry in batch], "document")
            if vectors is None or self._index is None:
                return
            for entry, vector in zip(batch, vectors, strict=True):
                self._index.set_vector(entry["id"], vector)

    def _readable_entries(
        self,
        *,
        filter_node: dict[str, Any] | None,
        show_expired: bool,
        as_of: datetime | None = None,
    ) -> list[dict[str, Any]]:
        at = as_of or datetime.now(timezone.utc)
        readable = []
        for entry in self._entries.values():
            if not show_expired and is_expired(entry.get("expiresAt"), at):
                continue
            if as_of:
                happened = parse_instant(entry.get("occurredAt") or entry["createdAt"])
                if math.isfinite(happened) and happened > as_of.timestamp():
                    continue
            if filter_node and not matches_filter(to_filterable(entry), filter_node):
                continue
            readable.append(entry)
        return readable

    def list(
        self, *, filter_node: dict[str, Any] | None = None, show_expired: bool = False
    ) -> list[dict[str, Any]]:
        self.ensure_loaded()
        entries = self._readable_entries(filter_node=filter_node, show_expired=show_expired)
        return sorted(entries, key=lambda entry: entry["createdAt"], reverse=True)

    def holds(self, memory_id: str) -> bool:
        """Whether this device already knows the memory is here."""
        return memory_id in self._entries

    def get(self, memory_id: str) -> dict[str, Any] | None:
        self.ensure_loaded()
        return self._entries.get(memory_id)

    def search(
        self,
        *,
        query: str,
        limit: int,
        threshold: float,
        mode: str,
        filter_node: dict[str, Any] | None = None,
        show_expired: bool = False,
        as_of: datetime | None = None,
        rerank_hits: bool = False,
    ) -> list[dict[str, Any]]:
        self.ensure_loaded()
        index = self._index
        assert index is not None
        allowed = {
            entry["id"]
            for entry in self._readable_entries(
                filter_node=filter_node, show_expired=show_expired, as_of=as_of
            )
        }
        fetch = candidate_count(limit)

        semantic: dict[str, float] = {}
        if mode != "keyword":
            vectors = self._embed([query], "query")
            if vectors:
                for hit in index.semantic(vectors[0], fetch, allowed.__contains__):
                    semantic[hit["id"]] = hit["score"]
        keyword: dict[str, float] = {}
        if mode != "semantic":
            for hit in index.keyword(tokenize(query), fetch, allowed.__contains__):
                keyword[hit["id"]] = hit["score"]
        named = set(entity_candidates(query))

        def entity_score(memory_id: str) -> float:
            names = self._entries[memory_id].get("entities") or []
            return ENTITY_BOOST if any(normalize_entity(n) in named for n in names) else 0

        ranked = rank(
            [
                {
                    "id": memory_id,
                    "semantic": semantic.get(memory_id),
                    "keyword": keyword.get(memory_id, 0),
                    "entity": entity_score(memory_id),
                }
                for memory_id in dict.fromkeys([*semantic, *keyword])
            ],
            query_terms=query_term_count(query),
            limit=limit,
            threshold=threshold,
            mode=mode,
        )
        results = [{**self._entries[hit["id"]], **hit} for hit in ranked]
        if rerank_hits and len(results) > 1:
            model = self._deps.model()
            if model:
                try:
                    scores = llm.rerank_texts(model, query, [r["text"] for r in results])
                    for result, score in zip(results, scores, strict=True):
                        result["rerankScore"] = score
                    results.sort(key=lambda result: -result["rerankScore"])
                except Exception as error:
                    log.warning("rerank skipped: %s", error)
        return results

    def _drafts_for(
        self,
        *,
        messages: list[dict[str, Any]],
        infer: bool,
        procedural: bool,
        prompt: str | None,
        categories: list[dict[str, Any]] | None,
        occurred_at: str | None,
        user_id: str | None,
        agent_id: str | None,
    ) -> tuple[list[dict[str, Any]], str | None]:
        """The facts in this conversation, as drafts ready to store."""

        def as_written() -> list[dict[str, Any]]:
            drafts = []
            for message in messages:
                text = message_text(message).strip()
                if text and message["role"] != "system":
                    attributed = "assistant" if message["role"] == "assistant" else "user"
                    drafts.append({"text": text, "attributedTo": attributed})
            return drafts

        if not infer:
            return as_written(), None
        model = self._deps.model()
        if not model:
            note = "No model is set for Private memory, so this was stored as written."
            return [{**draft, "raw": True} for draft in as_written()], note
        if procedural:
            text = llm.procedural_record(model, messages, prompt)
            return [{"text": text, "memoryType": "procedural"}], None
        settings = self._deps.settings(self.id)
        try:
            nearby = self.search(
                query="\n".join(map(message_text, messages))[:_QUERY_FOR_NEARBY_CHARS],
                limit=_KNOWN_MEMORIES,
                threshold=0,
                mode="semantic",
                show_expired=True,
            )
        except (MemDotError, ValueError):
            nearby = []
        try:
            extracted = llm.extract_memories(
                model,
                messages=messages,
                known=[hit["text"] for hit in nearby],
                instructions=prompt or settings.get("instructions"),
                categories=categories or settings.get("categories"),
                observed_at=occurred_at or iso_now(),
                agent_scoped=bool(agent_id and not user_id),
            )
        except Exception as error:
            # Whatever went wrong with the model, what the person said isn't lost.
            log.warning("extraction failed, keeping the raw text: %s", error)
            note = "The model couldn't read this, so it was stored as written."
            return [{**draft, "raw": True} for draft in as_written()], note
        return [
            {
                "text": memory["text"],
                "entities": memory["entities"],
                "relations": memory.get("relations") or [],
                "categories": memory["categories"],
                "attributedTo": memory["attributed_to"],
            }
            for memory in extracted
        ], None

    def add(
        self,
        *,
        messages: list[dict[str, Any]],
        user_id: str | None = None,
        agent_id: str | None = None,
        run_id: str | None = None,
        metadata: dict[str, Any] | None = None,
        expires_at: str | None = None,
        occurred_at: str | None = None,
        infer: bool = True,
        procedural: bool = False,
        prompt: str | None = None,
        categories: list[dict[str, Any]] | None = None,
        immutable: bool = False,
        source: dict[str, Any] | None = None,
        actor: str | None = None,
        wait: bool = False,
    ) -> dict[str, Any]:
        self.ensure_loaded()
        drafts, note = self._drafts_for(
            messages=messages,
            infer=infer,
            procedural=procedural,
            prompt=prompt,
            categories=categories,
            occurred_at=occurred_at,
            user_id=user_id,
            agent_id=agent_id,
        )
        seen = {dedupe_key(entry["text"], entry) for entry in self._entries.values()}
        now = iso_now()
        scope = {
            key: value
            for key, value in (("userId", user_id), ("agentId", agent_id), ("runId", run_id))
            if value
        }
        duplicates = 0
        fresh: list[dict[str, Any]] = []
        for draft in drafts:
            text = draft["text"]
            key = dedupe_key(text, scope)
            if key in seen:
                duplicates += 1
                continue
            seen.add(key)
            change = {"event": "ADD", "text": text, "previous": None, "at": now}
            if actor:
                change["actor"] = actor
            entry: dict[str, Any] = {
                "v": 1,
                "id": str(uuid.uuid4()),
                "version": 1,
                "memoryType": "fact",
                **draft,
                "text": text,
                **scope,
            }
            if metadata:
                entry["metadata"] = metadata
            if source:
                entry["source"] = source
            if immutable:
                entry["immutable"] = True
            if occurred_at:
                entry["occurredAt"] = occurred_at
            if expires_at:
                entry["expiresAt"] = expires_at
            entry.update(createdAt=now, updatedAt=now, history=[change])
            fresh.append(entry)
        job_id = (self._write_entries(fresh, wait))["job_id"] if fresh else None
        return {"entries": fresh, "duplicates": duplicates, "note": note, "job_id": job_id}

    def import_items(self, items: list[dict[str, Any]], source: str) -> dict[str, int]:
        """Stores imported memories as written, one segment per pack, the same fact only once."""
        self.ensure_loaded()
        seen = {dedupe_key(entry["text"], entry) for entry in self._entries.values()}
        now = iso_now()
        fresh: list[dict[str, Any]] = []
        duplicates = 0
        for item in items:
            key = dedupe_key(item["text"], item)
            if key in seen:
                duplicates += 1
                continue
            seen.add(key)
            entry: dict[str, Any] = {
                "v": 1,
                "id": str(uuid.uuid4()),
                "version": 1,
                "memoryType": "fact",
                "text": item["text"],
            }
            for field in ("userId", "agentId", "runId", "metadata", "categories", "expiresAt"):
                if item.get(field):
                    entry[field] = item[field]
            entry.update(
                source={"kind": "import", "label": source},
                createdAt=item.get("createdAt") or now,
                updatedAt=item.get("updatedAt") or now,
                history=[{"event": "ADD", "text": item["text"], "previous": None, "at": now}],
            )
            fresh.append(entry)
        pack: list[dict[str, Any]] = []
        size = 0
        for entry in fresh:
            length = len(encode_entry(entry))
            if pack and size + length > SEGMENT_PACK_BYTES:
                self._write_entries(pack, False)
                pack, size = [], 0
            pack.append(entry)
            size += length
        if pack:
            self._write_entries(pack, False)
        return {"imported": len(fresh), "duplicates": duplicates}

    def _write_entries(self, entries: list[dict[str, Any]], wait: bool) -> dict[str, str]:
        """One sealed segment on V3, then the ids at MemDot. Reused by add, update and compaction."""
        packed = [
            SegmentEntry(id=entry["id"], kind="memory", data=encode_entry(entry))
            for entry in entries
        ]
        if sum(len(entry.data) for entry in packed) > SEGMENT_PACK_BYTES:
            raise MemDotError(400, "TOO_LARGE", "Write fewer memories at a time.")
        space = self._deps.spaces.raw(self.space_id)
        require_sponsored(space)
        recipient = self._ctx.vault.seal_to(self.space_id, space["keyEpoch"])
        sealed = crypto.seal_segment(packed, recipient)
        declared = store_object(
            self._ctx,
            kind="segment",
            space_id=self.space_id,
            folder_id=self.id,
            key_epoch=space["keyEpoch"],
            size_bytes=len(sealed),
            root=sealed,
            skip_record=True,
        )
        rows = []
        for entry in entries:
            row: dict[str, Any] = {"id": entry["id"], "version": entry["version"]}
            source = entry.get("source") or {}
            if source.get("objectId"):
                row["source_object_id"] = source["objectId"]
            rows.append(row)
        self._ctx.transport.json(
            "POST",
            f"/v1/namespaces/{seg(self.id)}/private/entries",
            {"segment_id": declared["object"]["id"], "entries": rows},
        )
        if wait:
            self._deps.jobs.wait_for(declared["job"]["id"])

        # Reading this segment back would only return what's already here.
        self._opened[declared["object"]["cid"]] = entries
        for entry in entries:
            self._entries[entry["id"]] = entry
            if self._index:
                self._index.put(entry["id"], entry["version"], entry["text"])
        self._embed_into(entries)
        self._dirty += len(entries)
        return {"job_id": declared["job"]["id"], "segment_id": declared["object"]["id"]}

    def update(
        self,
        memory_id: str,
        *,
        text: str | None = None,
        metadata: dict[str, Any] | None = None,
        expires_at: Any = ...,
        actor: str | None = None,
        wait: bool = False,
    ) -> dict[str, Any]:
        self.ensure_loaded()
        current = self._entries.get(memory_id)
        if not current:
            raise NotFoundError(404, "NOT_FOUND", "Memory not found.")
        if current.get("immutable"):
            raise ConflictError(409, "IMMUTABLE", "This memory is immutable, so it can't change.")
        now = iso_now()
        new_text = current["text"] if text is None else text
        next_entry = {k: v for k, v in current.items() if k != "expiresAt"}
        next_entry.update(text=new_text, version=current["version"] + 1, updatedAt=now)
        if metadata:
            next_entry["metadata"] = {**(current.get("metadata") or {}), **metadata}
        kept = current.get("expiresAt") if expires_at is ... else expires_at
        if kept:
            next_entry["expiresAt"] = kept
        # The old entity names described the old text.
        if new_text != current["text"]:
            next_entry["entities"] = []
            next_entry["relations"] = []
        change = {"event": "UPDATE", "text": new_text, "previous": current["text"], "at": now}
        if actor:
            change["actor"] = actor
        next_entry["history"] = [*(current.get("history") or []), change]
        self._write_entries([next_entry], wait)
        return next_entry

    def forget(self, ids: list[str]) -> None:
        """Drops forgotten memories from what this device holds; MemDot has already marked them."""
        for memory_id in ids:
            self._entries.pop(memory_id, None)
            if self._index:
                self._index.remove(memory_id)

    def compact(self) -> dict[str, int]:
        """Rewrites what's still alive in mostly dead segments into one new segment.

        Runs here, because only this device can read them.
        """
        self.ensure_loaded()
        state = self._state()
        live: dict[str, int] = {}
        for row in state["live"]:
            if row.get("segment_id"):
                live[row["segment_id"]] = live.get(row["segment_id"], 0) + 1
        segments = state["segments"]
        targets = {s["id"]: s for s in segments if live.get(s["id"], 0) * 2 < s["entries"]}
        if len(segments) > _COMPACT_ABOVE_SEGMENTS:
            excess = len(segments) - _COMPACT_ABOVE_SEGMENTS // 2
            for segment in sorted(segments, key=lambda s: live.get(s["id"], 0))[:excess]:
                targets[segment["id"]] = segment
        if not targets:
            return {"segments": 0, "moved": 0}
        moving = [
            self._entries[row["id"]]
            for row in state["live"]
            if row.get("segment_id") in targets and row["id"] in self._entries
        ]
        if moving:
            self._write_entries(moving, True)
        for segment in targets.values():
            self._ctx.transport.json("DELETE", f"/v1/objects/{seg(segment['id'])}")
            self._ctx.registry.tombstone_object(self.space_id, segment["cid"])
            self._opened.pop(segment["cid"], None)
        return {"segments": len(targets), "moved": len(moving)}

    @property
    def unsaved(self) -> int:
        """Writes since the last snapshot."""
        return self._dirty

    def save_index(self, *, wait: bool) -> str:
        """Stores the index, encrypted, on V3, so another device can start without embedding it."""
        self.ensure_loaded()
        assert self._index is not None
        previous = (self._state()).get("snapshot")
        snapshot = self._index.to_snapshot(iso_now())
        space = self._deps.spaces.raw(self.space_id)
        require_sponsored(space)
        recipient = self._ctx.vault.seal_to(self.space_id, space["keyEpoch"])
        sealed = crypto.seal_to(snapshot, [recipient])
        declared = store_object(
            self._ctx,
            kind="index_snapshot",
            space_id=self.space_id,
            folder_id=self.id,
            key_epoch=space["keyEpoch"],
            size_bytes=len(sealed),
            root=sealed,
        )
        if wait:
            self._deps.jobs.wait_for(declared["job"]["id"])
        if previous:
            self._ctx.transport.json("DELETE", f"/v1/objects/{seg(previous['id'])}")
        self._dirty = 0
        return declared["object"]["cid"]

    def restore(self) -> dict[str, int]:
        """Throws away everything this device holds and rebuilds it from the chain alone."""
        self._entries.clear()
        self._opened.clear()
        self._index = None
        self._sync(from_chain=True)
        return {"restored": len(self._entries), "segments": len(self._opened)}

    def summary(self, *, filter_node: dict[str, Any] | None = None) -> str:
        model = self._deps.model()
        if not model:
            raise ConflictError(409, "MODEL_REQUIRED", "Set a model for Private memory first.")
        entries = self.list(filter_node=filter_node, show_expired=False)
        return (
            llm.summarize_memories(model, [entry["text"] for entry in entries]) if entries else ""
        )
