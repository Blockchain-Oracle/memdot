"""Keys, sealing and the formats every stored blob uses.

The same bytes as the TypeScript SDK's crypto package: `tests/vectors/ts-vectors.json` holds what
TypeScript made for this code to open, and `python-vectors.json` holds what this code made for
TypeScript to open. Everything here runs on your machine; nothing in it talks to anything.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
import secrets
import struct
from dataclasses import dataclass, field
from typing import Any

import pyrage
from mnemonic import Mnemonic
from nacl import bindings, signing

from ._constants import CHUNK_BYTES
from .errors import WrongKeyError

KEY_BYTES = 32

#: Domain-separation labels. Changing one changes every derived key, so they carry a version.
INFO = {
    "user": "memdot/user-x25519/v1",
    "object": "memdot/object-x25519/v1",
    "space": "memdot/space-x25519/v1",
    "spaceKey": "memdot/space-key/v1",
    "recoverySignIn": "memdot/recovery-signin-ed25519/v1",
    "owner": "memdot/owner-sr25519/v1",
    "grantTag": "memdot/grant-tag/v1",
}

_KEK_INFO = {
    "passkey": "memdot/kek/passkey/v1",
    "vrf": "memdot/kek/vrf/v1",
    "recovery": "memdot/kek/recovery/v1",
}
_XCHACHA_NONCE_BYTES = 24
_SALT_BYTES = 32
_SEGMENT_MAGIC = b"MDSEG1"
_BECH32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
_mnemonic = Mnemonic("english")


def dumps(value: Any) -> bytes:
    """JSON the way the TypeScript SDK writes it: compact, and with text left as it is."""
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()


# ── Keys ─────────────────────────────────────────────────────────────────────────────────────


def derive_key(ikm: bytes, info: str, salt: bytes | None = None) -> bytes:
    """HKDF-SHA256 for one 32-byte key. A missing salt means zeros, as in RFC 5869."""
    prk = hmac.new(salt if salt is not None else bytes(32), ikm, hashlib.sha256).digest()
    return hmac.new(prk, info.encode() + b"\x01", hashlib.sha256).digest()


def random_key() -> bytes:
    return secrets.token_bytes(KEY_BYTES)


def _x25519_public(secret_key: bytes) -> bytes:
    return bindings.crypto_scalarmult_base(secret_key)


def x25519_from_seed(seed: bytes, info: str) -> tuple[bytes, bytes]:
    """A deterministic pair (secret, public): holding the seed is holding the identity."""
    secret_key = derive_key(seed, info)
    return secret_key, _x25519_public(secret_key)


def generate_x25519() -> tuple[bytes, bytes]:
    secret_key = secrets.token_bytes(KEY_BYTES)
    return secret_key, _x25519_public(secret_key)


def _polymod(values: list[int]) -> int:
    generators = (0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3)
    checksum = 1
    for value in values:
        top = checksum >> 25
        checksum = ((checksum & 0x1FFFFFF) << 5) ^ value
        for i, generator in enumerate(generators):
            if (top >> i) & 1:
                checksum ^= generator
    return checksum


def _hrp_expand(hrp: str) -> list[int]:
    return [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp]


def _to_5bit(data: bytes) -> list[int]:
    words: list[int] = []
    accumulator = 0
    bits = 0
    for byte in data:
        accumulator = (accumulator << 8) | byte
        bits += 8
        while bits >= 5:
            bits -= 5
            words.append((accumulator >> bits) & 31)
    if bits:
        words.append((accumulator << (5 - bits)) & 31)
    return words


def _bech32_encode(hrp: str, data: bytes) -> str:
    words = _to_5bit(data)
    checksum = _polymod([*_hrp_expand(hrp), *words, 0, 0, 0, 0, 0, 0]) ^ 1
    tail = [(checksum >> 5 * (5 - i)) & 31 for i in range(6)]
    return f"{hrp}1{''.join(_BECH32[word] for word in [*words, *tail])}"


def _bech32_decode(text: str) -> tuple[str, bytes]:
    lowered = text.lower()
    hrp, _, body = lowered.rpartition("1")
    words = [_BECH32.index(c) for c in body]
    if _polymod([*_hrp_expand(hrp), *words]) != 1:
        raise ValueError("bad bech32 checksum")
    accumulator = 0
    bits = 0
    out = bytearray()
    for word in words[:-6]:
        accumulator = (accumulator << 5) | word
        bits += 5
        if bits >= 8:
            bits -= 8
            out.append((accumulator >> bits) & 0xFF)
    return hrp, bytes(out)


def age_recipient(public_key: bytes) -> str:
    return _bech32_encode("age", public_key)


def age_identity(secret_key: bytes) -> str:
    return _bech32_encode("age-secret-key-", secret_key).upper()


def public_key_from_age_recipient(recipient: str) -> bytes:
    hrp, key = _bech32_decode(recipient)
    if hrp != "age":
        raise ValueError(f"not an age recipient: {recipient}")
    return key


def new_agent_identity() -> tuple[str, str]:
    """A fresh pair for a device: (identity, public key). The identity never leaves it."""
    secret_key, public_key = generate_x25519()
    return age_identity(secret_key), age_recipient(public_key)


def user_key_pair(master_key: bytes) -> tuple[bytes, bytes]:
    return x25519_from_seed(master_key, INFO["user"])


def user_recipient(master_key: bytes) -> str:
    return age_recipient(user_key_pair(master_key)[1])


def user_identity(master_key: bytes) -> str:
    return age_identity(user_key_pair(master_key)[0])


def owner_seed(master_key: bytes) -> bytes:
    """The chain-account seed: an sr25519 mini secret only the master key can produce."""
    return derive_key(master_key, INFO["owner"])


def grant_tag(
    master_key: bytes,
    *,
    space_id: str,
    object_id: str | None,
    grantee_kind: str,
    grantee: str,
    scope: str,
) -> str:
    """Proves this account's own client meant to share this. Made here and checked here."""
    message = "\n".join([space_id, object_id or "", grantee_kind, grantee, scope])
    key = derive_key(master_key, INFO["grantTag"])
    return hmac.new(key, message.encode(), hashlib.sha256).hexdigest()


# ── Sealing ──────────────────────────────────────────────────────────────────────────────────


def seal_to(data: bytes, recipients: list[str]) -> bytes:
    """Encrypts to one or more age recipients (`age1…` X25519 public keys)."""
    if not recipients:
        raise ValueError("at least one recipient is required")
    return pyrage.encrypt(data, [pyrage.x25519.Recipient.from_str(r) for r in recipients])


def open_with(ciphertext: bytes, identities: str | list[str], what: str | None = None) -> bytes:
    """Decrypts with any of the identities, for example every epoch of a space key."""
    held = [identities] if isinstance(identities, str) else identities
    try:
        return pyrage.decrypt(ciphertext, [pyrage.x25519.Identity.from_str(i) for i in held])
    except (pyrage.DecryptError, pyrage.IdentityError, ValueError) as error:
        raise WrongKeyError(what) from error


# ── Spaces ───────────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class SpaceKey:
    """A symmetric key for one epoch of a space; its X25519 identity is derived from it."""

    epoch: int
    key: bytes


def derive_space_key(master_key: bytes, space_id: str, epoch: int) -> SpaceKey:
    return SpaceKey(epoch, derive_key(master_key, f"{INFO['spaceKey']}/{space_id}/{epoch}"))


def derive_space_keys(master_key: bytes, space_id: str, through_epoch: int) -> list[SpaceKey]:
    return [derive_space_key(master_key, space_id, epoch) for epoch in range(through_epoch + 1)]


def _space_pair(space_key: SpaceKey) -> tuple[bytes, bytes]:
    return x25519_from_seed(space_key.key, f"{INFO['space']}/{space_key.epoch}")


def space_recipient(space_key: SpaceKey) -> str:
    return age_recipient(_space_pair(space_key)[1])


def space_identity(space_key: SpaceKey) -> str:
    return age_identity(_space_pair(space_key)[0])


def keyring_identities(keys: list[SpaceKey]) -> list[str]:
    """Identities from a keyring, newest epoch first."""
    return [space_identity(key) for key in sorted(keys, key=lambda k: k.epoch, reverse=True)]


def seal_space_keyring(space_id: str, keys: list[SpaceKey], recipients: list[str]) -> bytes:
    keyring = {
        "v": 1,
        "kind": "space-keyring",
        "spaceId": space_id,
        "keys": [{"epoch": k.epoch, "key": base64.b64encode(k.key).decode()} for k in keys],
    }
    return seal_to(dumps(keyring), recipients)


def open_space_keyring(
    ciphertext: bytes, identities: str | list[str]
) -> tuple[str, list[SpaceKey]]:
    keyring = json.loads(open_with(ciphertext, identities, "the space keyring"))
    if keyring.get("v") != 1 or keyring.get("kind") != "space-keyring":
        raise ValueError("unsupported keyring")
    return keyring["spaceId"], [
        SpaceKey(k["epoch"], base64.b64decode(k["key"])) for k in keyring["keys"]
    ]


# ── Objects and manifests ────────────────────────────────────────────────────────────────────


def padme_length(length: int) -> int:
    """Rounds a length up so at most O(log log L) bits of it leak, at about 12% overhead at most."""
    if length < 2:
        return length
    exponent = length.bit_length() - 1
    last_bits = exponent - exponent.bit_length()
    step = 1 << last_bits
    # Rounds `length + step - 1` up rather than down, to give the same sizes as the TypeScript SDK.
    return -(-(length + step - 1) // step) * step


def pad_to(data: bytes, length: int) -> bytes:
    if length < len(data):
        raise ValueError("padding length is shorter than the data")
    return data + bytes(length - len(data))


def object_recipient(object_key: bytes) -> str:
    return age_recipient(x25519_from_seed(object_key, INFO["object"])[1])


def object_identity(object_key: bytes) -> str:
    return age_identity(x25519_from_seed(object_key, INFO["object"])[0])


def split_chunks(data: bytes, chunk_bytes: int = CHUNK_BYTES) -> list[bytes]:
    if chunk_bytes <= 0:
        raise ValueError("chunk size must be positive")
    return [data[i : i + chunk_bytes] for i in range(0, len(data), chunk_bytes)] or [b""]


@dataclass(frozen=True)
class EncryptedObject:
    """One age stream cut into chunks. The key lives only inside the encrypted manifest."""

    object_key: bytes
    chunks: list[bytes]
    size: int
    padded_size: int


def encrypt_object(plaintext: bytes, chunk_bytes: int = CHUNK_BYTES) -> EncryptedObject:
    object_key = random_key()
    padded_size = padme_length(len(plaintext))
    ciphertext = seal_to(pad_to(plaintext, padded_size), [object_recipient(object_key)])
    return EncryptedObject(
        object_key, split_chunks(ciphertext, chunk_bytes), len(plaintext), padded_size
    )


def decrypt_object(chunks: list[bytes], object_key: bytes, size: int) -> bytes:
    padded = open_with(b"".join(chunks), object_identity(object_key), "the object")
    if size > len(padded):
        raise ValueError("recorded size exceeds the decrypted object")
    return padded[:size]


def build_manifest(
    *,
    name: str,
    mime: str,
    size: int,
    padded_size: int,
    object_key: bytes,
    chunks: list[dict[str, Any]],
    created_at: str,
) -> dict[str, Any]:
    return {
        "v": 1,
        "kind": "file",
        "name": name,
        "mime": mime,
        "size": size,
        "paddedSize": padded_size,
        "objectKey": base64.b64encode(object_key).decode(),
        "chunks": chunks,
        "createdAt": created_at,
    }


def manifest_object_key(manifest: dict[str, Any]) -> bytes:
    return base64.b64decode(manifest["objectKey"])


def seal_manifest(manifest: dict[str, Any], recipients: list[str]) -> bytes:
    return seal_to(dumps(manifest), recipients)


def open_manifest(ciphertext: bytes, identities: str | list[str]) -> dict[str, Any]:
    manifest = json.loads(open_with(ciphertext, identities, "the manifest"))
    if manifest.get("v") != 1 or manifest.get("kind") != "file":
        raise ValueError("unsupported manifest")
    return manifest


# ── Segments ─────────────────────────────────────────────────────────────────────────────────


@dataclass
class SegmentEntry:
    """One small item in a segment: a tiny file, or a memory."""

    id: str
    kind: str
    data: bytes
    name: str | None = None
    mime: str | None = None
    meta: dict[str, Any] | None = field(default=None)


def pack_segment(entries: list[SegmentEntry]) -> bytes:
    """`MDSEG1` | u32 header length | header JSON | concatenated entry bytes."""
    offset = 0
    described: list[dict[str, Any]] = []
    for entry in entries:
        row: dict[str, Any] = {"id": entry.id, "kind": entry.kind}
        if entry.name is not None:
            row["name"] = entry.name
        if entry.mime is not None:
            row["mime"] = entry.mime
        if entry.meta is not None:
            row["meta"] = entry.meta
        row["offset"] = offset
        row["length"] = len(entry.data)
        described.append(row)
        offset += len(entry.data)
    header = dumps({"v": 1, "entries": described})
    payload = b"".join(entry.data for entry in entries)
    return _SEGMENT_MAGIC + struct.pack(">I", len(header)) + header + payload


def unpack_segment(data: bytes) -> list[SegmentEntry]:
    if not data.startswith(_SEGMENT_MAGIC):
        raise ValueError("not a MemDot segment")
    start = len(_SEGMENT_MAGIC) + 4
    (header_length,) = struct.unpack(">I", data[len(_SEGMENT_MAGIC) : start])
    header = json.loads(data[start : start + header_length])
    if header.get("v") != 1:
        raise ValueError("unsupported segment version")
    payload = data[start + header_length :]
    return [
        SegmentEntry(
            id=row["id"],
            kind=row["kind"],
            name=row.get("name"),
            mime=row.get("mime"),
            meta=row.get("meta"),
            data=payload[row["offset"] : row["offset"] + row["length"]],
        )
        for row in header["entries"]
    ]


def seal_segment(entries: list[SegmentEntry], recipient: str) -> bytes:
    """Seals a segment to one recipient; a segment must fit in a single stored chunk."""
    sealed = seal_to(pack_segment(entries), [recipient])
    if len(sealed) > CHUNK_BYTES:
        raise ValueError("segment exceeds one storage chunk; split it")
    return sealed


def open_segment(ciphertext: bytes, identities: str | list[str]) -> list[SegmentEntry]:
    return unpack_segment(open_with(ciphertext, identities, "the segment"))


# ── The key bundle ───────────────────────────────────────────────────────────────────────────


def _wrap_key(kind: str, unlock_secret: bytes, salt: bytes) -> bytes:
    return derive_key(unlock_secret, _KEK_INFO[kind], salt)


def _wrap_aad(kind: str, wrap_id: str) -> bytes:
    return f"memdot/key-bundle/v1|{kind}|{wrap_id}".encode()


def add_wrap(
    bundle: dict[str, Any],
    master_key: bytes,
    *,
    kind: str,
    wrap_id: str,
    unlock_secret: bytes,
    salt: bytes | None = None,
) -> dict[str, Any]:
    salt = salt if salt is not None else secrets.token_bytes(_SALT_BYTES)
    nonce = secrets.token_bytes(_XCHACHA_NONCE_BYTES)
    ciphertext = bindings.crypto_aead_xchacha20poly1305_ietf_encrypt(
        master_key, _wrap_aad(kind, wrap_id), nonce, _wrap_key(kind, unlock_secret, salt)
    )
    wraps = [w for w in bundle["wraps"] if not (w["kind"] == kind and w["id"] == wrap_id)]
    wraps.append(
        {
            "kind": kind,
            "id": wrap_id,
            "salt": base64.b64encode(salt).decode(),
            "ciphertext": base64.b64encode(nonce + ciphertext).decode(),
        }
    )
    return {"v": 1, "wraps": wraps}


def parse_key_bundle(data: bytes) -> dict[str, Any]:
    bundle = json.loads(data)
    if bundle.get("v") != 1 or not isinstance(bundle.get("wraps"), list):
        raise ValueError("unsupported key bundle")
    return bundle


def unwrap_master_key(
    bundle: dict[str, Any], kind: str, unlock_secret: bytes, wrap_id: str | None = None
) -> bytes:
    """Tries every wrap of the given kind (optionally one id) and returns the master key."""
    for wrap in bundle["wraps"]:
        if wrap["kind"] != kind or (wrap_id is not None and wrap["id"] != wrap_id):
            continue
        sealed = base64.b64decode(wrap["ciphertext"])
        try:
            master_key = bindings.crypto_aead_xchacha20poly1305_ietf_decrypt(
                sealed[_XCHACHA_NONCE_BYTES:],
                _wrap_aad(kind, wrap["id"]),
                sealed[:_XCHACHA_NONCE_BYTES],
                _wrap_key(kind, unlock_secret, base64.b64decode(wrap["salt"])),
            )
        except Exception:
            # Authentication failed for this wrap; try the next one.
            continue
        if len(master_key) == KEY_BYTES:
            return master_key
    raise WrongKeyError("the key bundle")


# ── The recovery code ────────────────────────────────────────────────────────────────────────


def normalize_recovery_code(code: str) -> str:
    return " ".join(re.split(r"\s+", code.strip().lower()))


def is_valid_recovery_code(code: str) -> bool:
    return _mnemonic.check(normalize_recovery_code(code))


def recovery_secret(code: str) -> bytes:
    """The unlock secret for the recovery wrap in the key bundle."""
    normalized = normalize_recovery_code(code)
    if not _mnemonic.check(normalized):
        raise ValueError("recovery code checksum failed")
    return bytes(_mnemonic.to_entropy(normalized))


def recovery_sign_in_key(code: str) -> signing.SigningKey:
    """Ed25519 key for signing in with the code alone; the server only has its public half."""
    return signing.SigningKey(derive_key(recovery_secret(code), INFO["recoverySignIn"]))


def sign_recovery_challenge(code: str, challenge: bytes) -> bytes:
    return recovery_sign_in_key(code).sign(challenge).signature
