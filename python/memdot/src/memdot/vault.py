"""Keys held in memory while the account is unlocked. Nothing here is ever sent to the API."""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from . import crypto
from .crypto import SpaceKey
from .errors import ConflictError, LockedError


class Vault:
    """The master key, and what received grants opened.

    A connected agent has no master key: its own identity opens the keyrings shared with it, and
    those are all it can read or seal with. Locking forgets all of it.
    """

    def __init__(self) -> None:
        self._master_key: bytes | None = None
        self._agent_identity: str | None = None
        self._keyrings: dict[str, list[SpaceKey]] = {}
        self._received: dict[str, dict[str, Any]] = {}
        self._listeners: set[Callable[[], None]] = set()

    @property
    def unlocked(self) -> bool:
        """Holds the owner's master key."""
        return self._master_key is not None

    @property
    def is_agent(self) -> bool:
        """Runs as a connected agent, on the keys shared with it."""
        return self._agent_identity is not None

    @property
    def holds_keys(self) -> bool:
        """Can open sealed data at all: the owner, unlocked, or a connected agent."""
        return self.unlocked or self.is_agent

    def use_agent_identity(self, identity: str) -> None:
        self._forget()
        self._agent_identity = identity
        self._notify()

    def set_keyring(self, space_id: str, keys: list[SpaceKey]) -> None:
        self._keyrings[space_id] = keys

    def newest_epoch(self, space_id: str) -> int:
        """The newest epoch this agent can open in a space; -1 when it holds none."""
        return max((key.epoch for key in self._keyrings.get(space_id, [])), default=-1)

    def unlock(self, master_key: bytes) -> None:
        self._forget()
        self._master_key = bytes(master_key)
        self._notify()

    def lock(self) -> None:
        was_unlocked = self.unlocked
        self._forget()
        if was_unlocked:
            self._notify()

    def subscribe(self, listener: Callable[[], None]) -> Callable[[], None]:
        """Calls the listener whenever the vault locks or unlocks; returns the unsubscribe."""
        self._listeners.add(listener)
        return lambda: self._listeners.discard(listener)

    def amk(self, what: str | None = None) -> bytes:
        if self._master_key is None:
            raise LockedError(what or "this")
        return self._master_key

    def identity(self) -> str:
        """This account's sharing identity (opens what others shared with it)."""
        return self._agent_identity or crypto.user_identity(self.amk("that"))

    def recipient(self) -> str:
        return crypto.user_recipient(self.amk("that"))

    def space_key(self, space_id: str, epoch: int) -> SpaceKey:
        """The key for one epoch of a space."""
        if self.is_agent:
            for key in self._keyrings.get(space_id, []):
                if key.epoch == epoch:
                    return key
            raise ConflictError(
                409,
                "KEY_BEHIND",
                "This agent doesn't have this space's current key. "
                "It arrives the next time the owner opens MemDot.",
            )
        return crypto.derive_space_key(self.amk("that"), space_id, epoch)

    def seal_to(self, space_id: str, epoch: int) -> str:
        return crypto.space_recipient(self.space_key(space_id, epoch))

    def owned_identities(self, space_id: str, through_epoch: int) -> list[str]:
        """Identities for every epoch so far, newest first, for anything sealed in this space."""
        if self.is_agent:
            return crypto.keyring_identities(
                [k for k in self._keyrings.get(space_id, []) if k.epoch <= through_epoch]
            )
        return [
            crypto.space_identity(self.space_key(space_id, epoch))
            for epoch in range(through_epoch, -1, -1)
        ]

    def remember_received(self, grant_id: str, keys: dict[str, Any]) -> None:
        self._received[grant_id] = keys

    def received_keys(self, grant_id: str) -> dict[str, Any] | None:
        return self._received.get(grant_id)

    def forget_received(self, grant_id: str) -> None:
        self._received.pop(grant_id, None)

    def _forget(self) -> None:
        self._master_key = None
        self._agent_identity = None
        self._keyrings.clear()
        self._received.clear()

    def _notify(self) -> None:
        for listener in list(self._listeners):
            listener()
