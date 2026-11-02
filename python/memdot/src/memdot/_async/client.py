"""The MemDot client. Encryption happens here, on your device."""

from __future__ import annotations

import logging
from typing import Any

import httpx

from .. import credentials as creds
from .._constants import DEFAULT_API_URL, PORTALDOT_RPC_URL
from ..embedder import Embedder
from ..errors import MemDotError
from ..models import AddResult, Memory, MemoryPage, ScoredMemory, Usage
from ..vault import Vault
from .account import AsyncAccount
from .agents import AsyncAgents
from .chain import AsyncChainClient
from .context import AsyncContext
from .data import AsyncData
from .files import AsyncFiles
from .memories import AsyncMemories
from .registry_log import AsyncRegistryLog
from .sharing import AsyncSharing
from .simple import AsyncActivity, AsyncJobs, AsyncKeys, AsyncProof
from .spaces import AsyncFolders, AsyncSpaces
from .transport import AsyncTransport

log = logging.getLogger("memdot")


def _scope_filters(
    filters: dict[str, Any] | None,
    user_id: str | None,
    agent_id: str | None,
    run_id: str | None,
) -> dict[str, Any] | None:
    merged = dict(filters or {})
    for key, value in (("user_id", user_id), ("agent_id", agent_id), ("run_id", run_id)):
        if value:
            merged[key] = value
    return merged or None


class AsyncMemDot:
    """The API only ever receives ciphertext, sealed names and CIDs."""

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str | None = None,
        origin: str | None = None,
        client: str | None = None,
        rpc: str | None = None,
        embedder: Embedder | None = None,
        identity: str | None = None,
        complete_grants_on_unlock: bool = True,
        http: httpx.AsyncClient | None = None,
    ) -> None:
        resolved = creds.from_environment(api_key, base_url, identity)
        self._rpc = rpc or PORTALDOT_RPC_URL
        self._complete_grants = complete_grants_on_unlock
        self._chain: AsyncChainClient | None = None
        url = resolved["api_url"] or DEFAULT_API_URL
        self._transport = AsyncTransport(
            url,
            api_key=resolved["api_key"],
            origin=origin or creds.dashboard_origin(url),
            client=client,
            http=http,
        )
        self._vault = Vault()
        self._registry = AsyncRegistryLog(self._transport, self._vault)
        ctx = AsyncContext(
            transport=self._transport,
            vault=self._vault,
            registry=self._registry,
            ensure_keys=self._ensure_keys,
            chain=self.chain,
        )
        self.jobs = AsyncJobs(ctx)
        self.keys = AsyncKeys(ctx)
        self.activity = AsyncActivity(ctx)
        self.proof = AsyncProof(ctx)
        self.spaces = AsyncSpaces(ctx)
        self.folders = AsyncFolders(ctx, self.spaces)
        self.files = AsyncFiles(ctx, self.spaces, self.jobs)
        self.sharing = AsyncSharing(ctx, self.spaces)
        self.memories = AsyncMemories(ctx, self.spaces, self.folders, self.jobs, embedder)
        self.data = AsyncData(ctx, self.spaces, self.folders, self.files, self.memories)
        self.agents = AsyncAgents(ctx, self.sharing)
        self.account = AsyncAccount(ctx, origin or creds.dashboard_origin(url), self._after_unlock)
        if resolved["api_key"] and resolved["identity"]:
            self._vault.use_agent_identity(resolved["identity"])

    @classmethod
    async def from_credentials(
        cls, *, client: str | None = None, embedder: Embedder | None = None, **flags: Any
    ) -> AsyncMemDot:
        """A client from `memdot login`'s file, the environment and these flags, in reverse order.

        With an agent identity it opens what was shared with that agent; with
        `MEMDOT_RECOVERY_CODE` it acts as the owner. The code is only ever read from the
        environment, never stored.
        """
        resolved = creds.resolve_credentials(creds.load_credentials(), flags)
        memdot = cls(
            resolved.api_key,
            base_url=resolved.api_url,
            client=client,
            embedder=embedder,
            identity=resolved.identity,
            complete_grants_on_unlock=False,
        )
        if resolved.recovery_code:
            await memdot.account.unlock_with_recovery_code(resolved.recovery_code)
        return memdot

    async def __aenter__(self) -> AsyncMemDot:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.aclose()

    def use_api_key(self, api_key: str | None) -> None:
        """Switch to (or drop) an API key, for example after minting one in a script."""
        self._transport.api_key = api_key

    def use_agent(self, *, api_key: str, identity: str) -> None:
        """Runs as a connected agent: this API key, and the device's own identity."""
        self._transport.api_key = api_key
        self._vault.use_agent_identity(identity)

    async def usage(self) -> Usage:
        return Usage.model_validate(await self._transport.json("GET", "/v1/usage"))

    def chain(self) -> AsyncChainClient:
        """This machine's own connection to Portaldot V3. Never routed through MemDot."""
        if self._chain is None:
            self._chain = AsyncChainClient(self._rpc)
        return self._chain

    async def aclose(self) -> None:
        """Closes the connections. Keys stay until `account.lock()`."""
        await self._transport.aclose()
        if self._chain is not None:
            await self._chain.aclose()
            self._chain = None

    # ── The memory verbs, at the top, for code moving here from another memory product ───────

    async def add(self, messages: Any, **options: Any) -> AddResult:
        return await self.memories.add(messages, **options)

    async def search(
        self,
        query: str,
        *,
        user_id: str | None = None,
        agent_id: str | None = None,
        run_id: str | None = None,
        filters: dict[str, Any] | None = None,
        limit: int | None = None,
        **options: Any,
    ) -> list[ScoredMemory]:
        if limit is not None:
            options.setdefault("top_k", limit)
        return await self.memories.search(
            query, filters=_scope_filters(filters, user_id, agent_id, run_id), **options
        )

    async def get_all(
        self,
        *,
        user_id: str | None = None,
        agent_id: str | None = None,
        run_id: str | None = None,
        filters: dict[str, Any] | None = None,
        **options: Any,
    ) -> MemoryPage:
        return await self.memories.list(
            filters=_scope_filters(filters, user_id, agent_id, run_id), **options
        )

    async def get(self, memory_id: str) -> Memory:
        return await self.memories.get(memory_id)

    async def update(self, memory_id: str, text: str | None = None, **options: Any) -> Memory:
        return await self.memories.update(memory_id, text=text, **options)

    async def delete(self, memory_id: str) -> None:
        await self.memories.delete(memory_id)

    async def delete_all(self, **scope: Any) -> int:
        return await self.memories.delete_all(**scope)

    async def history(self, memory_id: str) -> list[Any]:
        return await self.memories.history(memory_id)

    # ── Inside ───────────────────────────────────────────────────────────────────────────────

    async def _ensure_keys(self, space_id: str, epoch: int) -> None:
        await self.sharing.ensure_keys(space_id, epoch)

    async def _after_unlock(self) -> None:
        await self._registry.ensure_registered()
        # Records what the server stored while this device was away; never in the way of an unlock.
        try:
            await self.memories.record_server_segments()
        except MemDotError as error:
            log.warning("recording memory segments skipped: %s", error)
        if not self._complete_grants:
            return
        try:
            await self.sharing.complete_ready()
        except MemDotError as error:
            # A key without sharing rights, or an account being set up, simply has nothing to do.
            if error.status not in (403, 409):
                raise
