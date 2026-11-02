# Generated from ../_async by scripts/unasync.py. Edit that, not this.
"""What every part of the client shares."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from ..vault import Vault
    from .chain import ChainClient
    from .registry_log import RegistryLog
    from .transport import Transport


@dataclass
class Context:
    transport: Transport
    vault: Vault
    registry: RegistryLog
    ensure_keys: Callable[[str, int], None]
    chain: Callable[[], ChainClient]
