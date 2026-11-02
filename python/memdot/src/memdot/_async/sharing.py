"""Sharing, both sides. The owner wraps keys on this device.

A space grant seals the space's keyring (every epoch so far) to the recipient; a file grant re-seals
that file's manifest. If the recipient has no MemDot key yet the grant waits as pending, and
completes the next time the owner unlocks. Revoking moves the space to a new epoch the former grantee
never receives.
"""

from __future__ import annotations

import logging
import time
from typing import Any

from .. import crypto
from ..errors import MemDotError
from ..models import FileData, FileInfo, FilePage, Grant, Recipient, SharedDetails
from .context import AsyncContext
from .files import open_file_info, read_object, store_object
from .spaces import AsyncSpaces, open_text

log = logging.getLogger("memdot")

#: A key an agent is missing arrives when the owner next opens MemDot: no need to keep asking.
_KEY_RETRY_SECONDS = 30.0


def _share_target(to: dict[str, str]) -> dict[str, str]:
    if "address" in to or ("agent_id" in to and "agent_key" in to):
        return to
    raise ValueError('Share with {"address": …}, or {"agent_id": …, "agent_key": …}.')


class AsyncSharing:
    def __init__(self, ctx: AsyncContext, spaces: AsyncSpaces) -> None:
        self._ctx = ctx
        self._spaces = spaces
        #: When an agent behind on a space's key may ask for it again.
        self._key_retry_at: dict[str, float] = {}

    async def recipient(self, address: str) -> Recipient:
        return Recipient.model_validate(
            await self._ctx.transport.json("GET", f"/v1/recipients/{address}")
        )

    async def share_space(
        self,
        space_id: str,
        to: dict[str, str],
        *,
        scope: str = "read",
        expires_at: str | None = None,
    ) -> Grant:
        """Shares a whole space: current files, and new ones until revoked."""
        space = await self._spaces.raw(space_id)
        key = await self._recipient_key(_share_target(to))
        if not key:
            return await self._create(space_id, to, scope, expires_at)
        amk = self._ctx.vault.amk("sharing")
        keys = crypto.derive_space_keys(amk, space_id, space["keyEpoch"])
        wrapped = await self._store_grant_key(crypto.seal_space_keyring(space_id, keys, [key]))
        return await self._create(
            space_id, to, scope, expires_at, wrapped_key_cid=wrapped, key_epoch=space["keyEpoch"]
        )

    async def share_file(
        self,
        object_id: str,
        to: dict[str, str],
        *,
        scope: str = "read",
        expires_at: str | None = None,
    ) -> Grant:
        """Shares one file: its manifest is re-sealed to the recipient; the chunks are untouched."""
        detail = await self._detail(object_id)
        if not detail.get("spaceId"):
            raise MemDotError(400, "NOT_A_FILE", "That object is not a file.")
        if detail.get("segmentId"):
            raise MemDotError(
                400,
                "TINY_FILE_SHARE",
                "Files under 64 KiB live inside a shared segment; share their space instead.",
            )
        key = await self._recipient_key(_share_target(to))
        if not key:
            return await self._create(
                detail["spaceId"],
                to,
                scope,
                expires_at,
                object_id=object_id,
                object_cid=detail.get("cid"),
            )
        manifest = await self._own_manifest(detail)
        wrapped = await self._store_grant_key(crypto.seal_manifest(manifest, [key]))
        return await self._create(
            detail["spaceId"],
            to,
            scope,
            expires_at,
            object_id=object_id,
            object_cid=detail.get("cid"),
            wrapped_key_cid=wrapped,
        )

    async def list(self, direction: str = "given", space_id: str | None = None) -> list[Grant]:
        page = await self._ctx.transport.json(
            "GET", "/v1/grants", params={"direction": direction, "spaceId": space_id}
        )
        return [Grant.model_validate(item) for item in page["items"]]

    async def received(self, space_id: str | None = None) -> list[Grant]:
        return await self.list("received", space_id)

    async def revoke(self, grant_id: str) -> Any:
        """Stops future access and moves the space to a new key epoch."""
        given = await self.list("given")
        revoked = await self._ctx.transport.json("DELETE", f"/v1/grants/{grant_id}")
        for grant in given:
            if grant.id == grant_id:
                await self._ctx.registry.revoke_grant(grant.space_id, grant.id)
        return revoked

    async def complete_ready(self) -> int:
        """Wraps keys for every grant waiting on this account; returns how many it completed.

        Recipients who set up MemDot since you shared, and active space grants a revoke left one
        epoch behind. The client calls this after each unlock.
        """
        page = await self._ctx.transport.json("GET", "/v1/grants/ready")
        completed = 0
        amk = self._ctx.vault.amk("sharing")
        for item in page["items"]:
            grant = item["grant"]
            recipient_key = item["recipientKey"]
            # Only what this account's own client asked to share. A row added any other way, by a
            # stolen key or by the server itself, gets nothing wrapped for it.
            expected = crypto.grant_tag(
                amk,
                space_id=grant["spaceId"],
                object_id=grant.get("objectId"),
                grantee_kind=grant["granteeKind"],
                grantee=grant["grantee"],
                scope=grant["scope"],
            )
            if item.get("ownerTag") != expected or (
                grant["granteeKind"] == "agent" and recipient_key != grant["grantee"]
            ):
                log.warning("skipped a share this account's client didn't make: %s", grant["id"])
                continue
            completed += 1
            if grant.get("objectId"):
                manifest = await self._own_manifest(await self._detail(grant["objectId"]))
                wrapped = await self._store_grant_key(
                    crypto.seal_manifest(manifest, [recipient_key])
                )
                await self._complete(grant["id"], {"wrappedKeyCid": wrapped})
                continue
            epoch = grant["spaceKeyEpoch"]
            keys = crypto.derive_space_keys(amk, grant["spaceId"], epoch)
            wrapped = await self._store_grant_key(
                crypto.seal_space_keyring(grant["spaceId"], keys, [recipient_key])
            )
            await self._complete(grant["id"], {"wrappedKeyCid": wrapped, "keyEpoch": epoch})
        return completed

    async def ensure_keys(self, space_id: str, epoch: int) -> None:
        """A connected agent's keys for a space, from the grant wrapped to it.

        Asked again when the space has moved on: a revoke rotates the epoch, and the owner's next
        unlock wraps the new one.
        """
        vault = self._ctx.vault
        if not vault.is_agent or vault.newest_epoch(space_id) >= epoch:
            return
        if time.monotonic() < self._key_retry_at.get(space_id, 0):
            return
        self._key_retry_at[space_id] = time.monotonic() + _KEY_RETRY_SECONDS
        for grant in await self.list("received", space_id):
            if grant.status == "active" and not grant.object_id:
                vault.forget_received(grant.id)
                keys = await self.open(grant.id)
                if keys["kind"] == "space":
                    if keys["space_id"] != space_id:
                        raise MemDotError(409, "BAD_KEYRING", "That keyring is for another space.")
                    vault.set_keyring(space_id, keys["keys"])
                    self._key_retry_at.pop(space_id, None)
                return

    # ── What others shared with you ──────────────────────────────────────────────────────────

    async def open(self, grant_id: str) -> dict[str, Any]:
        """Opens a received grant's key on this device (a space keyring or a file manifest)."""
        cached = self._ctx.vault.received_keys(grant_id)
        if cached:
            return cached
        shared = await self._ctx.transport.json("GET", f"/v1/shared/{grant_id}")
        sealed = await self._ctx.transport.bytes(f"/v1/shared/{grant_id}/key")
        identity = self._ctx.vault.identity()
        if shared.get("objectId"):
            keys: dict[str, Any] = {
                "kind": "file",
                "manifest": crypto.open_manifest(sealed, identity),
            }
        else:
            space_id, held = crypto.open_space_keyring(sealed, identity)
            keys = {"kind": "space", "space_id": space_id, "keys": held}
        self._ctx.vault.remember_received(grant_id, keys)
        return keys

    async def details(self, grant_id: str) -> SharedDetails:
        """What a received grant opens, with its name decrypted here (space name, or the file's)."""
        shared = await self._ctx.transport.json("GET", f"/v1/shared/{grant_id}")
        keys = await self.open(grant_id)
        name = (
            keys["manifest"]["name"]
            if keys["kind"] == "file"
            else open_text(shared.get("encryptedName"), crypto.keyring_identities(keys["keys"]))
        )
        return SharedDetails.model_validate(
            {**{k: v for k, v in shared.items() if k != "encryptedName"}, "name": name}
        )

    async def files(
        self,
        grant_id: str,
        *,
        folder_id: str | None = None,
        cursor: str | None = None,
        limit: int | None = None,
    ) -> FilePage:
        """Files a received grant lets you open, names decrypted here."""
        keys = await self.open(grant_id)
        page = await self._ctx.transport.json(
            "GET",
            f"/v1/shared/{grant_id}/objects",
            params={"kind": "file", "folderId": folder_id, "cursor": cursor, "limit": limit},
        )
        items: list[FileInfo] = []
        for raw in page["items"]:
            if keys["kind"] == "space":
                items.append(open_file_info(raw, crypto.keyring_identities(keys["keys"])))
            else:
                manifest = keys["manifest"]
                info = open_file_info(raw, [])
                info.name, info.mime, info.size = (
                    manifest["name"],
                    manifest["mime"],
                    manifest["size"],
                )
                items.append(info)
        return FilePage(items=items, next_cursor=page.get("nextCursor"))

    async def get(self, grant_id: str, object_id: str) -> FileData:
        """Downloads and decrypts a file shared with you."""
        keys = await self.open(grant_id)
        detail = await self._shared_detail(grant_id, object_id)

        async def load_segment(segment_id: str) -> dict[str, Any]:
            return await self._shared_detail(grant_id, segment_id)

        if keys["kind"] == "file":
            return await read_object(self._ctx, detail, [], load_segment, keys["manifest"])
        identities = crypto.keyring_identities(keys["keys"])
        return await read_object(self._ctx, detail, identities, load_segment)

    async def _shared_detail(self, grant_id: str, object_id: str) -> dict[str, Any]:
        return await self._ctx.transport.json("GET", f"/v1/shared/{grant_id}/objects/{object_id}")

    async def _detail(self, object_id: str) -> dict[str, Any]:
        return await self._ctx.transport.json("GET", f"/v1/objects/{object_id}")

    async def _own_manifest(self, detail: dict[str, Any]) -> dict[str, Any]:
        """The owner opens their own manifest with the epoch it was sealed with."""
        if not detail.get("spaceId") or detail.get("keyEpoch") is None or not detail.get("cid"):
            raise MemDotError(409, "NOT_STORED", "That file is not stored yet.")
        identities = self._ctx.vault.owned_identities(detail["spaceId"], detail["keyEpoch"])
        return crypto.open_manifest(await self._ctx.transport.blob(detail["cid"]), identities[:1])

    async def _recipient_key(self, to: dict[str, str]) -> str | None:
        """The recipient's sealing key, or None when they have not set up MemDot yet."""
        if "agent_key" in to:
            return to["agent_key"]
        recipient = await self.recipient(to["address"])
        return recipient.encryption_key if recipient.registered else None

    async def _store_grant_key(self, sealed: bytes) -> str:
        """Stores a sealed key as a grant key object (an account object, renewed like any blob)."""
        declared = await store_object(
            self._ctx, kind="grant_key", size_bytes=len(sealed), root=sealed
        )
        return declared["object"]["cid"]

    async def _create(
        self,
        space_id: str,
        to: dict[str, str],
        scope: str,
        expires_at: str | None,
        *,
        object_id: str | None = None,
        object_cid: str | None = None,
        wrapped_key_cid: str | None = None,
        key_epoch: int | None = None,
    ) -> Grant:
        to_account = "address" in to
        grantee = (
            (await self.recipient(to["address"])).account_id if to_account else to["agent_key"]
        )
        tag = crypto.grant_tag(
            self._ctx.vault.amk("sharing"),
            space_id=space_id,
            object_id=object_id,
            grantee_kind="account" if to_account else "agent",
            grantee=grantee,
            scope=scope,
        )
        body: dict[str, Any] = {
            "ownerTag": tag,
            "spaceId": space_id,
            "grantee": {"kind": "account", "address": to["address"]}
            if to_account
            else {"kind": "agent", "agentId": to["agent_id"]},
            "scope": scope,
        }
        if object_id:
            body["objectId"] = object_id
        if expires_at:
            body["expiresAt"] = expires_at
        if wrapped_key_cid:
            body["wrappedKeyCid"] = wrapped_key_cid
        if key_epoch is not None:
            body["keyEpoch"] = key_epoch
        grant = Grant.model_validate(await self._ctx.transport.json("POST", "/v1/grants", body))
        await self._ctx.registry.grant(
            grant_id=grant.id,
            space_id=space_id,
            object_cid=object_cid,
            grantee=grant.grantee,
            scope=grant.scope,
            expires_at=grant.expires_at,
            wrapped_key_cid=wrapped_key_cid,
        )
        return grant

    async def _complete(self, grant_id: str, body: dict[str, Any]) -> Any:
        return await self._ctx.transport.json("POST", f"/v1/grants/{grant_id}/complete", body)
