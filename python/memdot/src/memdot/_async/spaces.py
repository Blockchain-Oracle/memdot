"""Spaces and folders. Names are sealed here before the API ever sees them."""

from __future__ import annotations

import base64
import uuid
from typing import Any

from .. import crypto
from ..crypto import WrongKeyError
from ..errors import MemDotError
from ..models import Folder, Space
from .context import AsyncContext


def to_base64(data: bytes) -> str:
    return base64.b64encode(data).decode()


def open_text(sealed: str | None, identities: list[str]) -> str | None:
    """Opens a sealed name with any of the identities; None when none of them fits."""
    if not sealed or not identities:
        return None
    try:
        return crypto.open_with(base64.b64decode(sealed), identities).decode()
    except WrongKeyError:
        return None


def seal_text(text: str, recipient: str) -> str:
    return to_base64(crypto.seal_to(text.encode(), [recipient]))


def _named(raw: dict[str, Any], name: str | None) -> dict[str, Any]:
    return {**{k: v for k, v in raw.items() if k != "encryptedName"}, "name": name}


class AsyncSpaces:
    def __init__(self, ctx: AsyncContext) -> None:
        self._ctx = ctx

    async def create(self, name: str, *, mode: str = "sponsored") -> Space:
        """Its id is chosen here so the name can be sealed with the space's own key (epoch 0)."""
        if self._ctx.vault.is_agent:
            raise MemDotError(
                403,
                "OWNER_ONLY",
                "Only the owner can create a space, since it needs their key. Do it in the dashboard.",
            )
        space_id = str(uuid.uuid4())
        sealed = seal_text(name, self._ctx.vault.seal_to(space_id, 0))
        raw = await self._ctx.transport.json(
            "POST", "/v1/spaces", {"id": space_id, "encryptedName": sealed, "mode": mode}
        )
        await self._ctx.registry.create_space(raw["id"], raw["mode"])
        return await self._open(raw)

    async def list(self) -> list[Space]:
        page = await self._ctx.transport.json("GET", "/v1/spaces")
        return [await self._open(raw) for raw in page["items"]]

    async def get(self, space_id: str) -> Space:
        return await self._open(await self.raw(space_id))

    async def raw(self, space_id: str) -> dict[str, Any]:
        space = await self._ctx.transport.json("GET", f"/v1/spaces/{space_id}")
        await self._ctx.ensure_keys(space_id, space["keyEpoch"])
        return space

    async def rename(self, space_id: str, name: str) -> Space:
        space = await self.raw(space_id)
        sealed = seal_text(name, self._ctx.vault.seal_to(space_id, space["keyEpoch"]))
        return await self._open(
            await self._ctx.transport.json(
                "PATCH", f"/v1/spaces/{space_id}", {"encryptedName": sealed}
            )
        )

    async def set_mode(self, space_id: str, mode: str) -> Space:
        """Who signs future writes: MemDot's relayer (sponsored) or a wallet (self-signed)."""
        return await self._open(
            await self._ctx.transport.json("PATCH", f"/v1/spaces/{space_id}", {"mode": mode})
        )

    async def delete(self, space_id: str) -> Any:
        """Tombstones everything in it and stops renewing; bytes expire within 7 days."""
        deleted = await self._ctx.transport.json("DELETE", f"/v1/spaces/{space_id}")
        await self._ctx.registry.delete_space(space_id)
        return deleted

    async def _open(self, raw: dict[str, Any]) -> Space:
        await self._ctx.ensure_keys(raw["id"], raw["keyEpoch"])
        vault = self._ctx.vault
        identities = vault.owned_identities(raw["id"], raw["keyEpoch"]) if vault.holds_keys else []
        return Space.model_validate(_named(raw, open_text(raw.get("encryptedName"), identities)))


class AsyncFolders:
    def __init__(self, ctx: AsyncContext, spaces: AsyncSpaces) -> None:
        self._ctx = ctx
        self._spaces = spaces

    async def create(
        self,
        space_id: str,
        name: str,
        *,
        parent_id: str | None = None,
        memory_mode: str = "off",
    ) -> Folder:
        space = await self._spaces.raw(space_id)
        sealed = seal_text(name, self._ctx.vault.seal_to(space_id, space["keyEpoch"]))
        raw = await self._ctx.transport.json(
            "POST",
            f"/v1/spaces/{space_id}/folders",
            {"encryptedName": sealed, "parentId": parent_id, "memoryMode": memory_mode},
        )
        return self._open(raw, space["keyEpoch"])

    async def list(self, space_id: str) -> list[Folder]:
        space = await self._spaces.raw(space_id)
        page = await self._ctx.transport.json("GET", f"/v1/spaces/{space_id}/folders")
        return [self._open(raw, space["keyEpoch"]) for raw in page["items"]]

    async def rename(self, folder_id: str, space_id: str, name: str) -> Folder:
        space = await self._spaces.raw(space_id)
        sealed = seal_text(name, self._ctx.vault.seal_to(space_id, space["keyEpoch"]))
        raw = await self._ctx.transport.json(
            "PATCH", f"/v1/folders/{folder_id}", {"encryptedName": sealed}
        )
        return self._open(raw, space["keyEpoch"])

    async def move(self, folder_id: str, parent_id: str | None) -> Any:
        return await self._ctx.transport.json(
            "PATCH", f"/v1/folders/{folder_id}", {"parentId": parent_id}
        )

    async def delete(self, folder_id: str) -> Any:
        return await self._ctx.transport.json("DELETE", f"/v1/folders/{folder_id}")

    def _open(self, raw: dict[str, Any], through_epoch: int) -> Folder:
        vault = self._ctx.vault
        identities = (
            vault.owned_identities(raw["spaceId"], through_epoch) if vault.holds_keys else []
        )
        return Folder.model_validate(_named(raw, open_text(raw.get("encryptedName"), identities)))
