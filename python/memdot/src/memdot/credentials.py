"""What `memdot login` leaves on this machine, readable only by you. The same file as the Node CLI."""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from ._constants import DEFAULT_API_URL

_DIR_MODE = 0o700
_FILE_MODE = 0o600
_FILE_NAME = "credentials.json"
_LOCAL_DASHBOARD = "http://localhost:3100"


def _env(name: str) -> str | None:
    value = os.environ.get(name, "").strip()
    return value or None


def credentials_dir() -> Path:
    """`MEMDOT_CREDENTIALS_DIR` must be absolute: a relative one could land a key in a repository."""
    configured = _env("MEMDOT_CREDENTIALS_DIR")
    if not configured:
        return Path.home() / ".memdot"
    if not os.path.isabs(configured):
        raise ValueError("MEMDOT_CREDENTIALS_DIR must be an absolute path.")
    return Path(configured)


def credentials_path() -> Path:
    return credentials_dir() / _FILE_NAME


def load_credentials() -> dict[str, Any] | None:
    try:
        return json.loads(credentials_path().read_text("utf8"))
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as error:
        raise ValueError(f"Couldn't read {credentials_path()}: {error}") from error


def save_credentials(credentials: dict[str, Any]) -> None:
    """Replaces the file in one step, so a crash never leaves half a key."""
    directory = credentials_dir()
    directory.mkdir(parents=True, exist_ok=True, mode=_DIR_MODE)
    directory.chmod(_DIR_MODE)
    temporary = directory / f".{_FILE_NAME}.{os.getpid()}.tmp"
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, _FILE_MODE)
        with os.fdopen(descriptor, "w", encoding="utf8") as file:
            file.write(json.dumps(credentials, indent=2, ensure_ascii=False) + "\n")
        temporary.chmod(_FILE_MODE)
        temporary.replace(credentials_path())
    except OSError:
        temporary.unlink(missing_ok=True)
        raise


def remove_credentials() -> None:
    credentials_path().unlink(missing_ok=True)


def _origin(url: str) -> tuple[str, str]:
    parts = urlsplit(url)
    return parts.scheme, parts.netloc


def _same_origin(a: str, b: str) -> bool:
    return _origin(a) == _origin(b)


def dashboard_origin(api_url: str) -> str:
    """Where the dashboard lives, for what's sent to the auth routes and the links it prints."""
    scheme, host = _origin(api_url)
    if host.startswith("api."):
        return f"{scheme}://app.{host[len('api.') :]}"
    return _LOCAL_DASHBOARD


def from_environment(
    api_key: str | None, base_url: str | None, identity: str | None
) -> dict[str, str | None]:
    """What a client made directly uses: what it was given, then the environment."""
    return {
        "api_key": api_key or _env("MEMDOT_API_KEY"),
        "api_url": base_url or _env("MEMDOT_API_URL") or DEFAULT_API_URL,
        "identity": identity or _env("MEMDOT_AGENT_IDENTITY"),
    }


@dataclass
class ResolvedCredentials:
    """The credentials in force, after flags and environment. Never written back to the file."""

    api_url: str
    api_key: str | None
    identity: str | None
    namespace_id: str | None
    user_id: str | None
    agent_id: str | None
    run_id: str | None
    recovery_code: str | None
    #: Where the key came from, for `memdot status`: "flag", "env", "file" or None.
    api_key_source: str | None


def resolve_credentials(
    file: dict[str, Any] | None, flags: dict[str, Any] | None = None
) -> ResolvedCredentials:
    """Flags beat the environment, which beats the file."""
    flags = flags or {}
    saved = file or {}
    from_env = _env("MEMDOT_API_KEY")
    api_url = (
        flags.get("api_url") or _env("MEMDOT_API_URL") or saved.get("api_url") or DEFAULT_API_URL
    )
    # The saved key goes only where it was saved for: pointing elsewhere mustn't hand it over.
    saved_key = (
        saved["api_key"]
        if saved.get("api_key") and _same_origin(api_url, saved.get("api_url", ""))
        else None
    )
    api_key = flags.get("api_key") or from_env or saved_key
    defaults = saved.get("defaults") or {}
    # A key from somewhere else isn't this file's agent, so it doesn't get that agent's identity.
    agent = saved.get("agent") or {}
    identity = _env("MEMDOT_AGENT_IDENTITY") or (
        agent.get("identity") if api_key and api_key == saved_key else None
    )
    source = None
    if flags.get("api_key"):
        source = "flag"
    elif from_env:
        source = "env"
    elif saved_key:
        source = "file"
    return ResolvedCredentials(
        api_url=api_url,
        api_key=api_key,
        identity=identity,
        namespace_id=flags.get("namespace")
        or _env("MEMDOT_NAMESPACE")
        or saved.get("namespace_id"),
        user_id=flags.get("user_id") or _env("MEMDOT_USER_ID") or defaults.get("user_id"),
        agent_id=flags.get("agent_id") or _env("MEMDOT_AGENT_ID") or defaults.get("agent_id"),
        run_id=flags.get("run_id") or _env("MEMDOT_RUN_ID") or defaults.get("run_id"),
        recovery_code=_env("MEMDOT_RECOVERY_CODE"),
        api_key_source=source,
    )
