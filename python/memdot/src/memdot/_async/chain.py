"""This machine's own connection to Portaldot V3. Never routed through MemDot."""

from __future__ import annotations

from typing import Any

import httpx

from .._constants import BITSWAP_TIMEOUT_SECONDS, PORTALDOT_RPC_URL
from ..chain import check_blob, decode_transaction_hashes, rpc_body, transactions_key


class NodeError(Exception):
    """A node answered, and said no."""


class AsyncChainClient:
    """JSON-RPC over HTTP: the two reads Verify and restore need don't take a chain library."""

    def __init__(self, url: str | None = None) -> None:
        target = url or PORTALDOT_RPC_URL
        self.url = target.replace("wss://", "https://").replace("ws://", "http://")
        self._http = httpx.AsyncClient(timeout=BITSWAP_TIMEOUT_SECONDS)

    async def _call(self, method: str, params: list[Any]) -> Any:
        response = await self._http.post(self.url, json=rpc_body(method, params))
        response.raise_for_status()
        answer = response.json()
        if answer.get("error"):
            raise NodeError(str(answer["error"].get("message") or answer["error"]))
        return answer.get("result")

    async def bitswap_get(self, cid: str) -> bytes:
        """Fetches a stored blob and checks it against its CID."""
        value = await self._call("bitswap_v1_get", [cid])
        if not value:
            raise NodeError(f"No node has {cid}.")
        return check_blob(cid, bytes.fromhex(value.removeprefix("0x")))

    async def stored_hashes(self, block: int) -> list[bytes]:
        """The content hash of everything a block stored, in order, from its own state."""
        block_hash = await self._call("chain_getBlockHash", [block])
        value = await self._call("state_getStorage", [transactions_key(block), block_hash])
        return decode_transaction_hashes(value)

    async def aclose(self) -> None:
        await self._http.aclose()
