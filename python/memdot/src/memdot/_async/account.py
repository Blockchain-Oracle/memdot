"""Sign-in, setup and unlock.

Signing in gives a session; unlocking gives this device the master key, which never leaves it.
Passkeys and browser wallets live in a browser, so they aren't here: use the recovery code, a script
wallet, or a key made in the dashboard.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlsplit

from .. import crypto
from ..crypto import owner_seed, recovery_secret
from ..errors import ConflictError, MemDotError
from ..wallet import Wallet
from .context import AsyncContext
from .files import store_object

_SIWS_VERSION = "1.0.0"


def _hex(value: bytes) -> str:
    return f"0x{value.hex()}"


def _owner_proof_message(user_id: str, owner_account: str) -> str:
    return f"memdot:owner:v1:{user_id}:{owner_account}"


def _siws_message(*, domain: str, uri: str, address: str, nonce: str) -> str:
    """The sign-in message, in the layout wallets and the API both parse."""
    now = datetime.now(timezone.utc)
    issued = f"{now.strftime('%Y-%m-%dT%H:%M:%S')}.{now.microsecond // 1000:03d}Z"
    return (
        f"{domain} wants you to sign in with your Portaldot account:\n"
        f"{address}\n\n"
        "Sign in to MemDot\n\n"
        f"URI: {uri}\n"
        f"Version: {_SIWS_VERSION}\n"
        f"Nonce: {nonce}\n"
        f"Issued At: {issued}"
    )


class AsyncAccount:
    def __init__(
        self,
        ctx: AsyncContext,
        default_origin: str | None,
        on_unlock: Callable[[], Awaitable[None]],
    ) -> None:
        self._ctx = ctx
        self._default_origin = default_origin
        self._on_unlock = on_unlock

    async def me(self) -> dict[str, Any]:
        return await self._ctx.transport.json("GET", "/v1/account")

    @property
    def unlocked(self) -> bool:
        return self._ctx.vault.unlocked

    def on_lock_change(self, listener: Callable[[], None]) -> Callable[[], None]:
        """Calls the listener when this device locks or unlocks; returns the unsubscribe."""
        return self._ctx.vault.subscribe(listener)

    async def sign_in_with_wallet(
        self, wallet: Wallet, *, origin: str | None = None, name: str | None = None
    ) -> str:
        """Sign-In with Substrate: the wallet signs a one-use message. Returns the user id."""
        target = origin or self._default_origin
        if not target:
            raise MemDotError(
                400, "ORIGIN_REQUIRED", "Pass `origin`: the dashboard URL the message names."
            )
        parts = urlsplit(target)
        answer = await self._ctx.transport.json("POST", "/api/auth/siws/nonce", {})
        message = _siws_message(
            domain=parts.netloc,
            uri=f"{parts.scheme}://{parts.netloc}",
            address=wallet.address,
            nonce=answer["nonce"],
        )
        body: dict[str, Any] = {"message": message, "signature": _hex(wallet.sign_message(message))}
        if name:
            body["name"] = name
        result = await self._ctx.transport.json("POST", "/api/auth/siws/verify", body)
        return result["user"]["id"]

    async def sign_in_with_recovery_code(self, code: str) -> str:
        """Signs in with the recovery code alone. Returns the user id."""
        key = crypto.recovery_sign_in_key(code)
        answer = await self._ctx.transport.json("POST", "/api/auth/recovery/challenge", {})
        challenge = answer["challenge"]
        result = await self._ctx.transport.json(
            "POST",
            "/api/auth/recovery/verify",
            {
                "publicKey": _hex(bytes(key.verify_key)),
                "challenge": challenge,
                "signature": _hex(crypto.sign_recovery_challenge(code, challenge.encode())),
            },
        )
        return result["user"]["id"]

    async def set_up(self, *, owner: Wallet | None = None) -> str:
        """Finishes a new account after sign-in; returns the recovery code, shown this once.

        Master key, recovery code, sharing key, owner proof, and the key bundle stored on chain.
        Without an owner wallet, the chain owner is a key derived from the master key. Leaves the
        account unlocked.
        """
        me = await self.me()
        code = _generate_recovery_code()
        master_key = crypto.random_key()
        bundle = crypto.add_wrap(
            {"v": 1, "wraps": []},
            master_key,
            kind="recovery",
            wrap_id="recovery",
            unlock_secret=recovery_secret(code),
        )
        await self._ctx.transport.json(
            "POST",
            "/api/auth/recovery/register",
            {"publicKey": _hex(bytes(crypto.recovery_sign_in_key(code).verify_key))},
        )
        await self._ctx.transport.json(
            "PUT",
            "/v1/account",
            {
                "owner": _owner_proof(me["user"]["id"], master_key, owner),
                "encryptionKey": crypto.user_recipient(master_key),
            },
        )
        await self._store_bundle(bundle)
        self._ctx.vault.unlock(master_key)
        await self._on_unlock()
        return code

    async def create(self, wallet: Wallet, *, origin: str | None = None) -> str:
        """Creates a MemDot account for a wallet; returns the recovery code, shown this once."""
        await self.sign_in_with_wallet(wallet, origin=origin)
        return await self.set_up(owner=wallet)

    async def unlock_methods(self) -> list[dict[str, str]]:
        """How this account can be unlocked: the key bundle's wraps (no secrets in them)."""
        bundle = await self._key_bundle()
        return [{"kind": wrap["kind"], "id": wrap["id"]} for wrap in bundle["wraps"]]

    async def unlock_with_recovery_code(self, code: str) -> None:
        """Opens the key bundle with the recovery code and keeps the master key on this device."""
        bundle = await self._key_bundle()
        self._ctx.vault.unlock(crypto.unwrap_master_key(bundle, "recovery", recovery_secret(code)))
        await self._on_unlock()

    async def unlock_with_master_key(self, master_key: bytes) -> None:
        """For servers that hold the exported master key (keep it like any private key)."""
        self._ctx.vault.unlock(master_key)
        await self._on_unlock()

    def lock(self) -> None:
        """Forgets every key on this device; the session stays signed in."""
        self._ctx.vault.lock()

    async def recover(self, code: str) -> None:
        """A new device or a lost passkey: sign in with the code, then unlock with it."""
        await self.sign_in_with_recovery_code(code)
        await self.unlock_with_recovery_code(code)

    async def regenerate_recovery_code(self) -> str:
        """Replaces the recovery code; the old one stops working. The new one is shown once."""
        master_key = self._ctx.vault.amk("a new recovery code")
        code = _generate_recovery_code()
        bundle = crypto.add_wrap(
            await self._key_bundle(),
            master_key,
            kind="recovery",
            wrap_id="recovery",
            unlock_secret=recovery_secret(code),
        )
        await self._ctx.transport.json(
            "POST",
            "/api/auth/recovery/register",
            {"publicKey": _hex(bytes(crypto.recovery_sign_in_key(code).verify_key))},
        )
        await self._store_bundle(bundle)
        return code

    async def remove_wallet_unlock(self, address: str) -> None:
        """Stops a wallet from unlocking through `signVrf` (its sign-in, if linked, stays)."""
        self._ctx.vault.amk("removing a wallet unlock")
        bundle = await self._key_bundle()
        wraps = [w for w in bundle["wraps"] if not (w["kind"] == "vrf" and w["id"] == address)]
        await self._store_bundle({"v": 1, "wraps": wraps})

    async def rename(self, name: str) -> None:
        """The display name MemDot greets you with (stays on MemDot's server, unencrypted)."""
        await self._ctx.transport.json("POST", "/api/auth/update-user", {"name": name})

    async def sign_out_everywhere(self) -> None:
        """Signs out every session of this account, this one included."""
        self.lock()
        await self._ctx.transport.json("POST", "/api/auth/revoke-sessions", {})

    async def sign_out(self) -> None:
        """Ends the session and forgets the keys on this device."""
        self.lock()
        await self._ctx.transport.json("POST", "/api/auth/sign-out", {})

    async def _key_bundle(self) -> dict[str, Any]:
        account = (await self.me()).get("account")
        if not account or not account.get("keyBundleCid"):
            raise ConflictError(
                409, "ACCOUNT_SETUP_REQUIRED", "This account has no key bundle yet."
            )
        return crypto.parse_key_bundle(await self._ctx.transport.blob(account["keyBundleCid"]))

    async def _store_bundle(self, bundle: dict[str, Any]) -> None:
        """Stores a key bundle as an account object and points the account at it."""
        data = crypto.dumps(bundle)
        declared = await store_object(self._ctx, kind="key_bundle", size_bytes=len(data), root=data)
        cid = declared["object"].get("cid") or ""
        await self._ctx.transport.json("PATCH", "/v1/account", {"keyBundleCid": cid})
        if cid:
            await self._ctx.registry.register_key(cid)


def _generate_recovery_code() -> str:
    from mnemonic import Mnemonic

    return Mnemonic("english").generate(128)


def _owner_proof(user_id: str, master_key: bytes, owner: Wallet | None) -> dict[str, str]:
    """Signs the owner proof with the owner wallet, or the key derived from the master key."""
    if owner:
        account = _hex(owner.public_key)
        signature = owner.sign_message(_owner_proof_message(user_id, account))
        return {"kind": "substrate", "account": account, "signature": _hex(signature)}
    try:
        import sr25519
    except ImportError as error:
        raise ImportError(
            'Creating an account needs the owner extra: pip install "memdot[owner]"'
        ) from error
    public_key, secret_key = sr25519.pair_from_seed(owner_seed(master_key))
    account = _hex(public_key)
    message = _owner_proof_message(user_id, account).encode()
    return {
        "kind": "substrate",
        "account": account,
        "signature": _hex(sr25519.sign((public_key, secret_key), message)),
    }
