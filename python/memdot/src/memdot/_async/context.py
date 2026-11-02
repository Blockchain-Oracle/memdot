"""What every part of the client shares."""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..vault import Vault
    from .chain import AsyncChainClient
    from .registry_log import AsyncRegistryLog
    from .transport import AsyncTransport


@dataclass
class AsyncContext:
    transport: AsyncTransport
    vault: Vault
    registry: AsyncRegistryLog
    ensure_keys: Callable[[str, int], Awaitable[None]]
    chain: Callable[[], AsyncChainClient]
