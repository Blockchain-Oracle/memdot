"""Addressing stored bytes, and asking a Portaldot V3 node about them directly.

Nothing here goes through MemDot: Verify is only worth something if it doesn't.
"""

from __future__ import annotations

import base64
import hashlib
from typing import Any

from ._constants import CID_PREFIX
from .errors import IntegrityError

_CONTENT_HASH_BYTES = 32
_MULTIBASE_BASE32 = "b"
#: `twox128("TransactionStorage") ++ twox128("Transactions")`: the list of what a block stored.
_TRANSACTIONS_PREFIX = "0e7b504e5df47062be129a8958a7a127ab1e1015a9876a8ce71a2f1cfd772bc9"
#: `TransactionInfo { chunk_root: H256, content_hash: H256, size: u32, block_chunks: u32 }`.
_TRANSACTION_INFO_BYTES = 72


def content_hash(data: bytes) -> bytes:
    """TransactionStorage records blake2b-256 of the stored bytes as `content_hash`."""
    return hashlib.blake2b(data, digest_size=_CONTENT_HASH_BYTES).digest()


def cid_from_content_hash(digest: bytes) -> str:
    if len(digest) != _CONTENT_HASH_BYTES:
        raise ValueError(f"content hash must be {_CONTENT_HASH_BYTES} bytes, got {len(digest)}")
    encoded = base64.b32encode(CID_PREFIX + digest).decode().rstrip("=").lower()
    return f"{_MULTIBASE_BASE32}{encoded}"


def cid_of(data: bytes) -> str:
    return cid_from_content_hash(content_hash(data))


def content_hash_from_cid(cid: str) -> bytes:
    if not cid.startswith(_MULTIBASE_BASE32):
        raise ValueError(f"unsupported multibase in CID {cid}")
    body = cid[1:].upper()
    decoded = base64.b32decode(body + "=" * (-len(body) % 8))
    if decoded[: len(CID_PREFIX)] != CID_PREFIX:
        raise ValueError(f"not a TransactionStorage CID: {cid}")
    return decoded[len(CID_PREFIX) :]


def check_blob(cid: str, data: bytes) -> bytes:
    """The bytes, once they're known to be what the CID names."""
    if content_hash(data) != content_hash_from_cid(cid):
        raise IntegrityError(cid)
    return data


def transactions_key(block: int) -> str:
    """The storage key for a block's list: `Blake2_128Concat` of its number, little-endian."""
    number = block.to_bytes(4, "little")
    return f"0x{_TRANSACTIONS_PREFIX}{hashlib.blake2b(number, digest_size=16).hexdigest()}{number.hex()}"


def decode_transaction_hashes(hex_value: str | None) -> list[bytes]:
    """Each stored item's content hash, in order: an item's index in a block is its position here."""
    if not hex_value:
        return []
    data = bytes.fromhex(hex_value.removeprefix("0x"))
    count, offset = _compact_length(data)
    return [
        data[start + _CONTENT_HASH_BYTES : start + 2 * _CONTENT_HASH_BYTES]
        for start in (offset + i * _TRANSACTION_INFO_BYTES for i in range(count))
    ]


def _compact_length(data: bytes) -> tuple[int, int]:
    """A SCALE compact integer, and how many bytes it took."""
    mode = data[0] & 0b11
    if mode == 0:
        return data[0] >> 2, 1
    if mode == 1:
        return int.from_bytes(data[:2], "little") >> 2, 2
    if mode == 2:
        return int.from_bytes(data[:4], "little") >> 2, 4
    size = (data[0] >> 2) + 4
    return int.from_bytes(data[1 : 1 + size], "little"), 1 + size


def rpc_body(method: str, params: list[Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}
