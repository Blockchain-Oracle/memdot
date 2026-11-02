"""The public, owner-signed record of an account's data, as calldata for `MemDotRegistry`.

Needs the `owner` extra. Agents don't use this: records take the owner's signature, and what an agent
writes gets recorded the next time the owner unlocks.
"""

from __future__ import annotations

import secrets
from types import SimpleNamespace
from typing import Any

from ._constants import EVM_CHAIN_ID

NO_SALT = f"0x{'00' * 32}"
_DOMAIN = "memdot/registry/v1"
_NONCE_BYTES = 8

ACTION = SimpleNamespace(
    RegisterKey=0,
    DeleteAccount=1,
    CreateSpace=2,
    DeleteSpace=3,
    AddObjects=4,
    TombstoneObjects=5,
    Grant=6,
    RevokeGrant=7,
    RegisterAgent=8,
    RevokeAgent=9,
)
OBJECT_KIND = {
    "file": 0,
    "manifest": 0,
    "segment": 1,
    "index_snapshot": 2,
    "key_bundle": 3,
    "grant_key": 4,
}
SPACE_MODE = {"sponsored": 0, "self_signed": 1}
SCOPE = {"read": 0, "read_write": 1}


def _eth() -> tuple[Any, Any]:
    try:
        from eth_abi import encode
        from eth_hash.auto import keccak
    except ImportError as error:
        raise ImportError(
            'Adding registry records needs the owner extra: pip install "memdot[owner]"'
        ) from error
    return encode, keccak


def _raw(value: str) -> bytes:
    return bytes.fromhex(value.removeprefix("0x"))


def _hex(value: bytes) -> str:
    return f"0x{value.hex()}"


def uuid_to_bytes32(uuid: str) -> str:
    """A MemDot uuid as bytes32, reversible so records map back to their rows."""
    return f"0x{uuid.replace('-', '').rjust(64, '0')}"


def action_hash(salt: str, action: int, data: str) -> str:
    """`keccak256(abi.encode(salt, action, keccak256(data)))`: what an owner authorizes."""
    encode, keccak = _eth()
    return _hex(
        keccak(encode(["bytes32", "uint8", "bytes32"], [_raw(salt), action, keccak(_raw(data))]))
    )


def signing_message(
    registry: str, owner: str, nonce: int, action: str, chain_id: int = EVM_CHAIN_ID
) -> str:
    """The bytes `MemDotRegistry.signingMessage` builds; the owner signs these with sr25519."""
    encode, _ = _eth()
    return _hex(
        encode(
            ["string", "uint256", "address", "bytes32", "uint64", "bytes32"],
            [_DOMAIN, chain_id, registry, _raw(owner), nonce, _raw(action)],
        )
    )


class _EncodeRecord:
    """Each record's data, in the layouts the registry's readers decode."""

    @staticmethod
    def _encode(types: list[str], values: list[Any]) -> str:
        encode, _ = _eth()
        return _hex(encode(types, values))

    def register_key(self, encryption_key: str, key_bundle_hash: str) -> str:
        return self._encode(["bytes32", "bytes32"], [_raw(encryption_key), _raw(key_bundle_hash)])

    def create_space(self, mode: int) -> str:
        return self._encode(["uint8"], [mode])

    def add_objects(self, content_hashes: list[str], kinds: list[int], sizes: list[int]) -> str:
        return self._encode(
            ["bytes32[]", "uint8[]", "uint64[]"], [[_raw(h) for h in content_hashes], kinds, sizes]
        )

    def tombstone_objects(self, content_hashes: list[str]) -> str:
        return self._encode(["bytes32[]"], [[_raw(h) for h in content_hashes]])

    def grant(
        self,
        grant_id: str,
        object_hash: str,
        grantee: str,
        scope: int,
        expires_at: int,
        wrapped_key_hash: str,
    ) -> str:
        return self._encode(
            ["bytes32", "bytes32", "bytes32", "uint8", "uint64", "bytes32"],
            [
                _raw(grant_id),
                _raw(object_hash),
                _raw(grantee),
                scope,
                expires_at,
                _raw(wrapped_key_hash),
            ],
        )

    def revoke_grant(self, grant_id: str) -> str:
        return self._encode(["bytes32"], [_raw(grant_id)])

    def agent_key(self, agent_key: str) -> str:
        return self._encode(["bytes32"], [_raw(agent_key)])


encode_record = _EncodeRecord()


def encode_call(owner: str, salt: str, action: int, data: str, nonce: int, signature: bytes) -> str:
    """Calldata for `MemDotRegistry.record`."""
    encode, keccak = _eth()
    selector = keccak(b"record(bytes32,bytes32,uint8,bytes,uint64,uint8[64])")[:4]
    return _hex(
        selector
        + encode(
            ["bytes32", "bytes32", "uint8", "bytes", "uint64", "uint8[64]"],
            [_raw(owner), _raw(salt), action, _raw(data), nonce, list(signature)],
        )
    )


def owner_pair(owner_seed: bytes) -> tuple[bytes, bytes]:
    """The sr25519 pair for a mini secret: the same public key the TypeScript SDK derives."""
    try:
        import sr25519
    except ImportError as error:
        raise ImportError(
            'Adding registry records needs the owner extra: pip install "memdot[owner]"'
        ) from error
    return sr25519.pair_from_seed(owner_seed)


def signed_call(*, owner_seed: bytes, registry: str, salt: str, action: int, data: str) -> str:
    """The record, signed by the key derived from the master key, ready for the relayer."""
    import sr25519

    public_key, secret_key = owner_pair(owner_seed)
    owner = _hex(public_key)
    nonce = int.from_bytes(secrets.token_bytes(_NONCE_BYTES), "big")
    message = signing_message(registry, owner, nonce, action_hash(salt, action, data))
    signature = sr25519.sign((public_key, secret_key), _raw(message))
    return encode_call(owner, salt, action, data, nonce, signature)
