"""A Substrate account in a script, for signing in. Needs the `owner` extra.

Self-signed spaces aren't reachable from here: signing a `store` needs Portaldot's runtime types, and
this package has no chain client. Use the TypeScript SDK or the dashboard for those.
"""

from __future__ import annotations

import hashlib
import unicodedata
from dataclasses import dataclass

from mnemonic import Mnemonic

_BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
_SS58_PREFIX = 42
_PBKDF2_ROUNDS = 2048


def ss58_address(public_key: bytes, prefix: int = _SS58_PREFIX) -> str:
    """The address wallets show for an AccountId32 (prefix 42, as `packages/config` has it)."""
    body = bytes([prefix]) + public_key
    checksum = hashlib.blake2b(b"SS58PRE" + body, digest_size=64).digest()[:2]
    number = int.from_bytes(body + checksum, "big")
    encoded = ""
    while number:
        number, remainder = divmod(number, 58)
        encoded = _BASE58[remainder] + encoded
    return encoded


def _sr25519():
    try:
        import sr25519
    except ImportError as error:
        raise ImportError(
            'Signing with a Substrate key needs the owner extra: pip install "memdot[owner]"'
        ) from error
    return sr25519


@dataclass
class Wallet:
    """Signs the way wallet extensions sign raw payloads: wrapped in `<Bytes>…</Bytes>`."""

    address: str
    public_key: bytes
    _secret_key: bytes

    @classmethod
    def from_seed(cls, mini_secret: bytes) -> Wallet:
        public_key, secret_key = _sr25519().pair_from_seed(mini_secret)
        return cls(ss58_address(public_key), public_key, secret_key)

    @classmethod
    def from_mnemonic(cls, mnemonic: str) -> Wallet:
        """The derivation polkadot.js and Talisman use, with an empty path."""
        normalized = unicodedata.normalize("NFKD", mnemonic)
        entropy = bytes(Mnemonic("english").to_entropy(normalized))
        seed = hashlib.pbkdf2_hmac("sha512", entropy, b"mnemonic", _PBKDF2_ROUNDS, 64)
        return cls.from_seed(seed[:32])

    def sign_message(self, message: str) -> bytes:
        wrapped = f"<Bytes>{message}</Bytes>".encode()
        return _sr25519().sign((self.public_key, self._secret_key), wrapped)
