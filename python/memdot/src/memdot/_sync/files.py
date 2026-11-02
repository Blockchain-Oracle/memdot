# Generated from ../_async by scripts/unasync.py. Edit that, not this.
"""Files: encrypted here, stored on Portaldot V3, and verified without going through MemDot."""

from __future__ import annotations

import json
import math
import uuid
from collections.abc import Callable
from typing import Any

import httpx

from .. import crypto
from .._concurrency import run_direct
from .._constants import (
    CHUNK_BYTES,
    STORE_FEE_BASE_PLANCK,
    STORE_FEE_PER_BYTE_PLANCK,
    TINY_FILE_BYTES,
)
from ..chain import cid_of, content_hash_from_cid
from ..crypto import SegmentEntry
from ..engine import iso_now
from ..errors import IntegrityError, MemDotError
from ..models import BlobCheck, FileData, FileInfo, FilePage, Job, PutResult, VerifyResult
from .chain import NodeError
from .context import Context
from .simple import Jobs
from .spaces import Spaces, open_text, to_base64

#: How many entries one registering request can hold (`MAX_SEGMENT_ENTRIES`).
_MAX_SEGMENT_ENTRIES = 150
#: A segment's budget, leaving room for its header and age's overhead (`SEGMENT_PACK_BYTES`).
SEGMENT_PACK_BYTES = 6_000_000
_NODE_ATTEMPTS = 2
_MANIFEST_ESTIMATE_BYTES = 700
_NOT_FROM_PYTHON = (
    "This space is self-signed: a wallet signs each store, and that needs Portaldot's runtime types, "
    "which this package doesn't carry. Use the dashboard or the TypeScript SDK for this space."
)


def require_sponsored(space: dict[str, Any]) -> None:
    if space.get("mode") == "self_signed":
        raise MemDotError(400, "WALLET_REQUIRED", _NOT_FROM_PYTHON)


def store_object(
    ctx: Context,
    *,
    kind: str,
    size_bytes: int,
    root: bytes,
    space_id: str | None = None,
    folder_id: str | None = None,
    key_epoch: int | None = None,
    encrypted_meta: bytes | None = None,
    chunks: list[bytes] | None = None,
    previous_version_id: str | None = None,
    idempotency_key: str | None = None,
    skip_record: bool = False,
) -> dict[str, Any]:
    """Declares an object (CIDs computed here), then uploads every blob for the relayer to store."""
    blobs: dict[str, bytes] = {cid_of(root): root}
    described = []
    for chunk in chunks or []:
        cid = cid_of(chunk)
        blobs[cid] = chunk
        described.append({"cid": cid, "size": len(chunk)})
    root_cid = cid_of(root)
    body: dict[str, Any] = {
        "kind": kind,
        "sizeBytes": size_bytes,
        "root": {"cid": root_cid, "size": len(root)},
        "chunks": described,
    }
    if space_id:
        body["spaceId"] = space_id
    if folder_id:
        body["folderId"] = folder_id
    if key_epoch is not None:
        body["keyEpoch"] = key_epoch
    if encrypted_meta:
        body["encryptedMeta"] = to_base64(encrypted_meta)
    if previous_version_id:
        body["previousVersionId"] = previous_version_id
    declared = ctx.transport.json(
        "POST",
        "/v1/objects",
        body,
        headers={"idempotency-key": idempotency_key or str(uuid.uuid4())},
    )
    for slot in declared["uploads"]:
        ctx.transport.send(
            "PUT",
            slot["url"],
            body=blobs[slot["cid"]],
            headers={"content-type": "application/octet-stream"},
        )
    # A key bundle is recorded by the account's RegisterKey record instead.
    if kind != "key_bundle" and not skip_record:
        ctx.registry.add_object(kind=kind, root_cid=root_cid, size=len(root), space_id=space_id)
    return declared


def open_file_info(raw: dict[str, Any], identities: list[str]) -> FileInfo:
    text = open_text(raw.get("encryptedMeta"), identities)
    meta = json.loads(text) if text else {}
    fields = {k: v for k, v in raw.items() if k not in ("encryptedMeta", "blobs")}
    return FileInfo.model_validate(
        {**fields, "name": meta.get("name"), "mime": meta.get("mime"), "size": meta.get("size")}
    )


def read_object(
    ctx: Context,
    detail: dict[str, Any],
    identities: list[str],
    load_segment: Callable[[str], dict[str, Any]],
    manifest: dict[str, Any] | None = None,
) -> FileData:
    """One file's plaintext, for your own files and, through a grant, files shared with you."""
    if detail.get("segmentId"):
        segment = load_segment(detail["segmentId"])
        if not segment.get("cid"):
            raise MemDotError(409, "NOT_STORED", "The segment is not stored yet.")
        entries = crypto.open_segment(ctx.transport.blob(segment["cid"]), identities)
        for entry in entries:
            if entry.id == detail["id"]:
                return FileData(data=entry.data, name=entry.name or "", mime=entry.mime or "")
        raise MemDotError(404, "NOT_FOUND", "The file is missing from its segment.")
    if not detail.get("cid"):
        raise MemDotError(409, "NOT_STORED", "The file is not stored yet.")
    opened = manifest or crypto.open_manifest(ctx.transport.blob(detail["cid"]), identities)
    chunks = [ctx.transport.blob(chunk["cid"]) for chunk in opened["chunks"]]
    data = run_direct(
        crypto.decrypt_object, chunks, crypto.manifest_object_key(opened), opened["size"]
    )
    return FileData(data=data, name=opened["name"], mime=opened["mime"])


class Files:
    def __init__(self, ctx: Context, spaces: Spaces, jobs: Jobs) -> None:
        self._ctx = ctx
        self._spaces = spaces
        self._jobs = jobs
        #: Each space's current key epoch, learned as files are read and written.
        self._epochs: dict[str, int] = {}

    def put(
        self,
        data: bytes,
        *,
        space_id: str,
        name: str,
        folder_id: str | None = None,
        mime: str = "application/octet-stream",
        previous_version_id: str | None = None,
        idempotency_key: str | None = None,
        wait: bool = True,
        on_progress: Callable[[Job], None] | None = None,
    ) -> PutResult:
        """Encrypts and stores a file; by default waits until it's finalized on Portaldot V3.

        Files under 64 KiB go into a segment (one stored blob, one renewal); larger ones become
        chunks plus a sealed manifest.
        """
        space = self._spaces.raw(space_id)
        require_sponsored(space)
        epoch = space["keyEpoch"]
        self._epochs[space_id] = epoch
        recipient = self._ctx.vault.seal_to(space_id, epoch)
        meta = {"name": name, "mime": mime, "size": len(data)}
        sealed_meta = crypto.seal_to(crypto.dumps(meta), [recipient])

        if len(data) <= TINY_FILE_BYTES and not previous_version_id:
            # A tiny file is a one-entry segment: one blob on chain, not a manifest and a chunk.
            entry_ids, job_id = self._store_segment(
                space, recipient, [(data, meta, sealed_meta)], folder_id, idempotency_key
            )
            file_id = entry_ids[0]
        else:
            encrypted = run_direct(crypto.encrypt_object, data)
            manifest = crypto.build_manifest(
                name=name,
                mime=mime,
                size=encrypted.size,
                padded_size=encrypted.padded_size,
                object_key=encrypted.object_key,
                chunks=[{"cid": cid_of(c), "bytes": len(c)} for c in encrypted.chunks],
                created_at=iso_now(),
            )
            declared = store_object(
                self._ctx,
                kind="file",
                space_id=space_id,
                folder_id=folder_id,
                key_epoch=epoch,
                encrypted_meta=sealed_meta,
                size_bytes=encrypted.padded_size,
                root=crypto.seal_manifest(manifest, [recipient]),
                chunks=encrypted.chunks,
                previous_version_id=previous_version_id,
                idempotency_key=idempotency_key,
            )
            file_id = declared["object"]["id"]
            job_id = declared["job"]["id"]

        job = self._jobs.wait_for(job_id, on_update=on_progress) if wait else self._jobs.get(job_id)
        return PutResult(file=self.info(file_id), job=job)

    def put_many(
        self,
        files: list[dict[str, Any]],
        *,
        space_id: str,
        folder_id: str | None = None,
        wait: bool = True,
        on_progress: Callable[[Job], None] | None = None,
    ) -> list[PutResult]:
        """Stores `{data, name, mime?}` files; tiny ones share encrypted segments. Input order back."""
        results: list[PutResult | None] = [None] * len(files)
        tiny = [(i, f) for i, f in enumerate(files) if len(f["data"]) <= TINY_FILE_BYTES]
        if tiny:
            space = self._spaces.raw(space_id)
            require_sponsored(space)
            self._epochs[space_id] = space["keyEpoch"]
            recipient = self._ctx.vault.seal_to(space_id, space["keyEpoch"])
            groups: list[list[tuple[int, dict[str, Any]]]] = []
            size = 0
            for item in tiny:
                length = len(item[1]["data"])
                if not groups or size + length > SEGMENT_PACK_BYTES:
                    groups.append([item])
                    size = length
                else:
                    groups[-1].append(item)
                    size += length
            for group in groups:
                entries = []
                for _, file in group:
                    meta = {
                        "name": file["name"],
                        "mime": file.get("mime") or "application/octet-stream",
                        "size": len(file["data"]),
                    }
                    sealed = crypto.seal_to(crypto.dumps(meta), [recipient])
                    entries.append((file["data"], meta, sealed))
                entry_ids, job_id = self._store_segment(space, recipient, entries, folder_id, None)
                job = (
                    self._jobs.wait_for(job_id, on_update=on_progress)
                    if wait
                    else self._jobs.get(job_id)
                )
                for (index, _), entry_id in zip(group, entry_ids, strict=True):
                    results[index] = PutResult(file=self.info(entry_id), job=job)
        for index, file in enumerate(files):
            if len(file["data"]) > TINY_FILE_BYTES:
                results[index] = self.put(
                    file["data"],
                    space_id=space_id,
                    folder_id=folder_id,
                    name=file["name"],
                    mime=file.get("mime") or "application/octet-stream",
                    wait=wait,
                    on_progress=on_progress,
                )
        return [result for result in results if result is not None]

    def _store_segment(
        self,
        space: dict[str, Any],
        recipient: str,
        files: list[tuple[bytes, dict[str, Any], bytes]],
        folder_id: str | None,
        idempotency_key: str | None,
    ) -> tuple[list[str], str]:
        """Seals files into one segment, declares it, and registers each file as an entry of it."""
        entry_ids = [str(uuid.uuid4()) for _ in files]
        segment = crypto.seal_segment(
            [
                SegmentEntry(
                    id=entry_id, kind="file", name=meta["name"], mime=meta["mime"], data=data
                )
                for entry_id, (data, meta, _) in zip(entry_ids, files, strict=True)
            ],
            recipient,
        )
        declared = store_object(
            self._ctx,
            kind="segment",
            space_id=space["id"],
            folder_id=folder_id,
            key_epoch=space["keyEpoch"],
            size_bytes=len(segment),
            root=segment,
            idempotency_key=idempotency_key,
        )
        for start in range(0, len(files), _MAX_SEGMENT_ENTRIES):
            rows = []
            for offset, (data, _, sealed) in enumerate(files[start : start + _MAX_SEGMENT_ENTRIES]):
                row: dict[str, Any] = {
                    "id": entry_ids[start + offset],
                    "encryptedMeta": to_base64(sealed),
                    "sizeBytes": len(data),
                }
                if folder_id:
                    row["folderId"] = folder_id
                rows.append(row)
            self._ctx.transport.json(
                "POST", f"/v1/objects/{declared['object']['id']}/entries", {"entries": rows}
            )
        return entry_ids, declared["job"]["id"]

    def get(self, file_id: str) -> FileData:
        """Downloads and decrypts a file on this device."""
        detail = self.detail(file_id)
        if not detail.get("spaceId") or detail.get("keyEpoch") is None:
            raise MemDotError(400, "NOT_A_FILE", "That object is not a file in a space.")
        self._ctx.ensure_keys(detail["spaceId"], detail["keyEpoch"])
        identities = self._ctx.vault.owned_identities(detail["spaceId"], detail["keyEpoch"])[:1]
        return read_object(self._ctx, detail, identities, self.detail)

    def info(self, file_id: str) -> FileInfo:
        detail = self.detail(file_id)
        return open_file_info(detail, self._identities_for(detail))

    def detail(self, file_id: str) -> dict[str, Any]:
        return self._ctx.transport.json("GET", f"/v1/objects/{file_id}")

    def list(
        self,
        *,
        space_id: str | None = None,
        folder_id: str | None = None,
        kind: str = "file",
        cursor: str | None = None,
        limit: int | None = None,
    ) -> FilePage:
        """Files (and other objects) in a space or folder, names decrypted here."""
        page = self._ctx.transport.json(
            "GET",
            "/v1/objects",
            params={
                "kind": kind,
                "spaceId": space_id,
                "folderId": folder_id,
                "cursor": cursor,
                "limit": limit,
            },
        )
        items = []
        for raw in page["items"]:
            info = open_file_info(raw, self._identities_for(raw))
            items.append(info)
        return FilePage(
            items=items, next_cursor=page.get("nextCursor"), head_block=page.get("headBlock")
        )

    def rename(self, file_id: str, name: str) -> FileInfo:
        """Renames by sealing new metadata; the stored bytes are untouched."""
        detail = self.detail(file_id)
        if not detail.get("spaceId"):
            raise MemDotError(400, "NOT_A_FILE", "That object is not a file.")
        space = self._spaces.raw(detail["spaceId"])
        current = open_file_info(detail, self._identities_for(detail))
        meta = {
            "name": name,
            "mime": current.mime or "application/octet-stream",
            "size": current.size or 0,
        }
        sealed = crypto.seal_to(
            crypto.dumps(meta), [self._ctx.vault.seal_to(space["id"], space["keyEpoch"])]
        )
        raw = self._ctx.transport.json(
            "PATCH", f"/v1/objects/{file_id}", {"encryptedMeta": to_base64(sealed)}
        )
        self._epochs[space["id"]] = space["keyEpoch"]
        return open_file_info(raw, self._identities_for(raw))

    def move(self, file_id: str, folder_id: str | None) -> Any:
        return self._ctx.transport.json("PATCH", f"/v1/objects/{file_id}", {"folderId": folder_id})

    def delete(self, file_id: str) -> Any:
        """Tombstones and stops renewing; the bytes expire from the chain within 7 days."""
        detail = self.detail(file_id)
        deleted = self._ctx.transport.json("DELETE", f"/v1/objects/{file_id}")
        # A file inside a segment has no blob of its own; the segment's record stays true.
        if detail.get("cid") and not detail.get("segmentId"):
            self._ctx.registry.tombstone_object(detail.get("spaceId"), detail["cid"])
        return deleted

    def versions(self, file_id: str) -> list[FileInfo]:
        page = self._ctx.transport.json("GET", f"/v1/objects/{file_id}/versions")
        return [open_file_info(raw, self._identities_for(raw)) for raw in page["items"]]

    def renew(self, file_id: str, *, wait: bool = True) -> Job:
        """Every stored blob moves to a fresh 7-day window, same CIDs."""
        job = Job.model_validate(self._ctx.transport.json("POST", f"/v1/objects/{file_id}/renew"))
        return self._jobs.wait_for(job.id) if wait else job

    def estimate(self, size: int) -> dict[str, Any]:
        """What storing `size` bytes of plaintext costs on V3, before anything is encrypted."""
        if size <= TINY_FILE_BYTES:
            return {"blobs": 1, "planck": _quote_store_fee(size + 300)}
        chunks = math.ceil(size / CHUNK_BYTES)
        planck = _quote_store_fee(_MANIFEST_ESTIMATE_BYTES)
        for i in range(chunks):
            planck += _quote_store_fee(min(CHUNK_BYTES, size - i * CHUNK_BYTES) + 200)
        return {"blobs": chunks + 1, "planck": planck}

    def verify(self, file_id: str) -> VerifyResult:
        """Checks a file over this machine's own connection to Portaldot V3, never through MemDot.

        Each blob is fetched by CID and hashed, and the block it was stored in must list that
        content hash at the recorded position.
        """
        detail = self.detail(file_id)
        target = self.detail(detail["segmentId"]) if detail.get("segmentId") else detail
        chain = self._ctx.chain()
        blobs = []
        for blob in target["blobs"]:
            cid = blob["cid"]
            # Wrong bytes, or a node saying it has none, is an answer; a dropped connection is not.
            retrievable = False
            answered = True
            for attempt in range(_NODE_ATTEMPTS):
                try:
                    chain.bitswap_get(cid)
                    retrievable = True
                    break
                except (IntegrityError, NodeError):
                    break
                except httpx.HTTPError:
                    answered = False if attempt == _NODE_ATTEMPTS - 1 else answered
            on_chain = False
            block, index = blob.get("block"), blob.get("indexInBlock")
            if block is not None and index is not None:
                wanted = content_hash_from_cid(cid)
                for attempt in range(_NODE_ATTEMPTS):
                    try:
                        hashes = chain.stored_hashes(block)
                        on_chain = index < len(hashes) and hashes[index] == wanted
                        break
                    except (NodeError, httpx.HTTPError):
                        # Failing to read a block is not evidence that the block lacks the item.
                        answered = False if attempt == _NODE_ATTEMPTS - 1 else answered
            blobs.append(
                BlobCheck(
                    cid=cid,
                    retrievable=retrievable,
                    on_chain=on_chain,
                    answered=answered,
                    block=block,
                    index=index,
                )
            )

        def passed(check: BlobCheck) -> bool:
            return check.retrievable and check.on_chain

        return VerifyResult(
            ok=all(passed(b) for b in blobs),
            inconclusive=any(not passed(b) for b in blobs)
            and all(passed(b) or not b.answered for b in blobs),
            blobs=blobs,
        )

    def _identities_for(self, raw: dict[str, Any]) -> list[str]:
        """Every epoch's identity up to the space's current one; space epochs are cached."""
        space_id = raw.get("spaceId")
        if not self._ctx.vault.holds_keys or not space_id:
            return []
        epoch = self._epochs.get(space_id)
        if epoch is None:
            epoch = (self._spaces.raw(space_id))["keyEpoch"]
            self._epochs[space_id] = epoch
        return self._ctx.vault.owned_identities(space_id, max(epoch, raw.get("keyEpoch") or 0))


def _quote_store_fee(size: int) -> int:
    return STORE_FEE_BASE_PLANCK + STORE_FEE_PER_BYTE_PLANCK * size
