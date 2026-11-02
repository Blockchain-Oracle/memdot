# Generated from ../_async by scripts/unasync.py. Edit that, not this.
"""Keeps the public, owner-signed record of this account's data in `MemDotRegistry`."""

from __future__ import annotations

import logging
import re
from datetime import datetime
from typing import TYPE_CHECKING, Any

from .. import registry as reg
from .._constants import REGISTRY_ADDRESS
from ..chain import content_hash_from_cid
from ..crypto import owner_seed, public_key_from_age_recipient
from ..errors import MemDotError

if TYPE_CHECKING:
    from ..vault import Vault
    from .transport import Transport

log = logging.getLogger("memdot")
_NO_OWNER_EXTRA = (
    'Registry records need the owner extra: pip install "memdot[owner]". '
    "They'll be added the next time the owner unlocks with it installed."
)
_HEX_32 = re.compile(r"^0x[0-9a-fA-F]{64}$")


def _hash_of(cid: str) -> str:
    return f"0x{content_hash_from_cid(cid).hex()}"


def _salt_of(space_id: str | None) -> str:
    return reg.uuid_to_bytes32(space_id) if space_id else reg.NO_SALT


class RegistryLog:
    """Records describe stored data rather than hold it: one that fails never fails the action."""

    def __init__(self, transport: Transport, vault: Vault) -> None:
        self._transport = transport
        self._vault = vault
        self._warned = False

    def ensure_registered(self) -> None:
        """Publishes the sharing key once for accounts that have not, as the first record."""
        if not self._vault.unlocked:
            return
        try:
            me = self._transport.json("GET", "/v1/account")
            account = me.get("account")
            if account and not account.get("registryOwner") and account.get("keyBundleCid"):
                self.register_key(account["keyBundleCid"])
        except MemDotError as error:
            log.warning("registry check skipped: %s", error)

    def register_key(self, key_bundle_cid: str) -> None:
        if not self._vault.unlocked:
            return
        key = public_key_from_age_recipient(self._vault.recipient())
        self._record(
            reg.NO_SALT,
            reg.ACTION.RegisterKey,
            lambda: reg.encode_record.register_key(f"0x{key.hex()}", _hash_of(key_bundle_cid)),
        )

    def delete_account_calldata(self) -> str | None:
        """The account's last record, signed but not sent: it goes with the delete request."""
        if not self._vault.unlocked:
            return None
        try:
            return self._signed_call(reg.NO_SALT, reg.ACTION.DeleteAccount, "0x")
        except ImportError:
            return None

    def create_space(self, space_id: str, mode: str) -> None:
        self._record(
            _salt_of(space_id),
            reg.ACTION.CreateSpace,
            lambda: reg.encode_record.create_space(reg.SPACE_MODE[mode]),
        )

    def delete_space(self, space_id: str) -> None:
        self._record(_salt_of(space_id), reg.ACTION.DeleteSpace, lambda: "0x")

    def add_object(
        self, *, kind: str, root_cid: str, size: int, space_id: str | None = None
    ) -> None:
        self.add_objects(space_id, [{"kind": kind, "root_cid": root_cid, "size": size}])

    def add_objects(self, space_id: str | None, items: list[dict[str, Any]]) -> None:
        """Several objects in one record, for the cost of one."""
        self._record(
            _salt_of(space_id),
            reg.ACTION.AddObjects,
            lambda: reg.encode_record.add_objects(
                [_hash_of(item["root_cid"]) for item in items],
                [reg.OBJECT_KIND.get(item["kind"], 0) for item in items],
                [item["size"] for item in items],
            ),
        )

    def tombstone_object(self, space_id: str | None, root_cid: str) -> None:
        self._record(
            _salt_of(space_id),
            reg.ACTION.TombstoneObjects,
            lambda: reg.encode_record.tombstone_objects([_hash_of(root_cid)]),
        )

    def grant(
        self,
        *,
        grant_id: str,
        space_id: str,
        grantee: str,
        scope: str,
        object_cid: str | None = None,
        expires_at: str | None = None,
        wrapped_key_cid: str | None = None,
    ) -> None:
        moment = (
            int(datetime.fromisoformat(expires_at.replace("Z", "+00:00")).timestamp())
            if expires_at
            else 0
        )
        self._record(
            _salt_of(space_id),
            reg.ACTION.Grant,
            lambda: reg.encode_record.grant(
                reg.uuid_to_bytes32(grant_id),
                _hash_of(object_cid) if object_cid else reg.NO_SALT,
                grantee if _HEX_32.match(grantee) else reg.NO_SALT,
                reg.SCOPE[scope],
                moment,
                _hash_of(wrapped_key_cid) if wrapped_key_cid else reg.NO_SALT,
            ),
        )

    def revoke_grant(self, space_id: str, grant_id: str) -> None:
        self._record(
            _salt_of(space_id),
            reg.ACTION.RevokeGrant,
            lambda: reg.encode_record.revoke_grant(reg.uuid_to_bytes32(grant_id)),
        )

    def register_agent(self, agent_key: str) -> None:
        key = public_key_from_age_recipient(agent_key)
        self._record(
            reg.NO_SALT,
            reg.ACTION.RegisterAgent,
            lambda: reg.encode_record.agent_key(f"0x{key.hex()}"),
        )

    def revoke_agent(self, agent_key: str) -> None:
        key = public_key_from_age_recipient(agent_key)
        self._record(
            reg.NO_SALT,
            reg.ACTION.RevokeAgent,
            lambda: reg.encode_record.agent_key(f"0x{key.hex()}"),
        )

    def _signed_call(self, salt: str, action: int, data: str) -> str:
        return reg.signed_call(
            owner_seed=owner_seed(self._vault.amk()),
            registry=REGISTRY_ADDRESS,
            salt=salt,
            action=action,
            data=data,
        )

    def _record(self, salt: str, action: int, data: Any) -> None:
        if not self._vault.unlocked:
            return
        try:
            calldata = self._signed_call(salt, action, data())
        except ImportError:
            if not self._warned:
                self._warned = True
                log.warning(_NO_OWNER_EXTRA)
            return
        try:
            self._transport.json("POST", "/v1/registry/records", {"calldata": calldata})
        except MemDotError as error:
            log.warning("registry record skipped: %s", error)
