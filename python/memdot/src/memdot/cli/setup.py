"""Connecting this machine, and what's saved on it."""

from __future__ import annotations

import contextlib
import getpass
import json
import os
import re
import socket
import subprocess
import sys
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import click
import httpx

from .. import credentials as creds
from .._async.agents import API_KEY_FORMAT
from .._sync.client import MemDot
from ..crypto import new_agent_identity
from ..engine import iso_now
from ..errors import MemDotError
from .context import CLIENT, VERSION, Arg, connect, credentials_of
from .output import EXIT, CliError, dim, emit, good, interactive, say, state, strong

#: Long enough for a passkey prompt and a look at the spaces. Matches the server's own limit.
_LOGIN_WAIT_SECONDS = 600
_CONTINUE_WAIT_SECONDS = 30
_POLL_SECONDS = 2
_KNOWN_CLIENTS = (("CLAUDECODE", "claude-code"), ("CURSOR_AGENT", "cursor"), ("CODEX_CLI", "codex"))
_KEY_VARIABLE = "MEMDOT_API_KEY"
#: `[ \t]`, not `\s`: a trailing newline must stay where it is.
_EXPORT_LINE = re.compile(rf"^([ \t]*export[ \t]+{_KEY_VARIABLE}[ \t]*=[ \t]*).*$", re.MULTILINE)
_SHELL_FILES = (".zshrc", ".bashrc", ".bash_profile")


def _client_name() -> str:
    return next((name for var, name in _KNOWN_CLIENTS if os.environ.get(var)), "cli")


def _default_label() -> str:
    return f"{_client_name()} on {socket.gethostname()}"


def _redact(key: str | None) -> str:
    if not key:
        return "(not set)"
    return f"{key[:2]}***" if len(key) <= 8 else f"{key[:7]}…{key[-4:]}"


def _anonymous(api_url: str) -> MemDot:
    """No key at all, even with one in the environment: nothing here is on anyone's behalf."""
    memdot = MemDot(base_url=api_url, client=CLIENT)
    memdot.use_api_key(None)
    return memdot


def _replace(path: Path, content: str) -> None:
    """Replaces a file in one step, keeping its permissions."""
    mode = path.stat().st_mode & 0o777
    temporary = path.parent / f".{path.name}.{os.getpid()}.tmp"
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
        with os.fdopen(descriptor, "w", encoding="utf8") as file:
            file.write(content)
        temporary.chmod(mode)
        temporary.replace(path)
    except OSError:
        temporary.unlink(missing_ok=True)
        raise


def _sync_settings(path: Path, key: str) -> bool:
    settings = json.loads(path.read_text("utf8"))
    env = settings.get("env")
    if not env or _KEY_VARIABLE not in env or env[_KEY_VARIABLE] == key:
        return False
    env[_KEY_VARIABLE] = key
    _replace(path, json.dumps(settings, indent=2, ensure_ascii=False) + "\n")
    return True


def _sync_shell(path: Path, key: str) -> bool:
    raw = path.read_text("utf8")
    if not _EXPORT_LINE.search(raw):
        return False
    replaced = _EXPORT_LINE.sub(lambda match: f'{match.group(1)}"{key}"', raw, count=1)
    if replaced == raw:
        return False
    _replace(path, replaced)
    return True


def sync_key(key: str) -> list[str]:
    """After a new key, updates the old one wherever you already keep it.

    Only ever changes a line that's there: it never adds a key to a file that didn't have one. A
    file it can't read or parse is left alone.
    """
    # This goes into shell files, and the server chose it: anything but a key is refused here.
    if not API_KEY_FORMAT.fullmatch(key):
        return []
    home = Path.home()
    attempts: list[tuple[Path, Callable[[Path, str], bool]]] = [
        (home / ".claude" / "settings.json", _sync_settings),
        *((home / name, _sync_shell) for name in _SHELL_FILES),
    ]
    changed = []
    for path, sync in attempts:
        try:
            if sync(path, key):
                changed.append(str(path))
        except (OSError, ValueError):
            # Missing or unreadable: nothing of ours in it.
            pass
    return changed


def _open_browser(url: str) -> None:
    opener = {"darwin": "open", "win32": "explorer"}.get(sys.platform, "xdg-open")
    # No browser here is fine: the address is already on screen.
    with contextlib.suppress(OSError):
        subprocess.Popen(
            [opener, url],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )


def _finish_login(
    file: dict[str, Any] | None,
    api_url: str,
    pending: dict[str, Any],
    collected: dict[str, Any],
) -> list[str]:
    """Saves the key and agent the device collected, and updates the key where it's already kept."""
    rest = {k: v for k, v in creds.for_api(file, api_url).items() if k != "pending"}
    saved = {
        **rest,
        "version": 1,
        "api_url": api_url,
        "api_key": collected["api_key"],
        "agent": {
            "id": collected.get("agent_id") or "",
            "label": pending["label"],
            "identity": pending["identity"],
            "public_key": pending["public_key"],
        },
        # A new memory has to be about someone; here that's you, until you say otherwise.
        "defaults": {"user_id": getpass.getuser(), **(rest.get("defaults") or {})},
        "created_at": iso_now(),
    }
    if collected.get("namespace_id"):
        saved["namespace_id"] = collected["namespace_id"]
    creds.save_credentials(saved)
    return sync_key(collected["api_key"])


def _collect(memdot: MemDot, pending: dict[str, Any], wait_seconds: float) -> dict[str, Any] | None:
    """Asks until the owner has answered, or the time runs out. None means still waiting."""
    until = time.monotonic() + wait_seconds
    while True:
        result = memdot.agents.poll_connect(
            pending["id"], pending["poll_secret"], pending["identity"]
        )
        if result.status == "approved" and result.api_key:
            return {
                "api_key": result.api_key,
                "agent_id": result.agent_id,
                "namespace_id": result.namespace_id,
                "owner_account": result.owner_account,
            }
        if result.status == "denied":
            raise CliError(
                "The request was refused in the browser.", EXIT["auth"], "CONNECT_DENIED"
            )
        if result.status == "expired":
            raise CliError(
                "The request expired. Run memdot login again.", EXIT["auth"], "CONNECT_EXPIRED"
            )
        if result.status == "delivered":
            raise CliError(
                "That result was already collected. Run memdot login again.",
                EXIT["conflict"],
                "CONNECT_DELIVERED",
            )
        if time.monotonic() >= until:
            return None
        time.sleep(_POLL_SECONDS)


def _save_api_key(api_url: str, key: str, namespace: str | None) -> list[str]:
    memdot = MemDot(key, base_url=api_url, client=CLIENT)
    try:
        memdot.usage()
    except MemDotError as error:
        if error.status == 401:
            raise CliError("That API key isn't valid.", EXIT["auth"], "BAD_KEY") from error
        raise
    file = creds.for_api(creds.load_credentials(), api_url)
    rest = {k: v for k, v in file.items() if k not in ("agent", "pending")}
    saved = {**rest, "version": 1, "api_url": api_url, "api_key": key, "created_at": iso_now()}
    if namespace:
        saved["namespace_id"] = namespace
    creds.save_credentials(saved)
    return sync_key(key)


def _emit_connected(collected: dict[str, Any], synced: list[str], *, welcome: bool) -> None:
    def show() -> None:
        click.echo(f"{good('Connected')} to {collected.get('owner_account') or 'your account'}.")
        click.echo(dim(f"Saved to {creds.credentials_path()}"))
        if welcome:
            if synced:
                click.echo(dim(f"Updated the key in {', '.join(synced)}"))
            click.echo('\nTry: memdot add "I prefer short answers" -u me --no-infer')

    emit(
        data={
            "connected": True,
            "agent_id": collected.get("agent_id"),
            "namespace_id": collected.get("namespace_id"),
            "owner_account": collected.get("owner_account"),
            "synced": synced,
        },
        text=show,
    )


def _run_login(
    ctx: click.Context,
    *,
    label: str,
    with_key: str | None = None,
    no_browser: bool = False,
    no_wait: bool = False,
    resume: bool = False,
    wait: float | None = None,
    print_env: bool = False,
) -> None:
    resolved = credentials_of(ctx)
    api_url = resolved.api_url

    if with_key:
        synced = _save_api_key(api_url, with_key, resolved.namespace_id)
        emit(
            data={"connected": True, "kind": "api_key", "api_url": api_url, "synced": synced},
            text=lambda: click.echo(
                f"{good('Connected')} with that key. Saved to {creds.credentials_path()}"
            ),
        )
        return

    memdot = _anonymous(api_url)
    file = creds.load_credentials()

    if resume:
        pending = (file or {}).get("pending")
        if not pending:
            raise CliError("No login is waiting. Run memdot login.", EXIT["usage"], "NO_PENDING")
        collected = _collect(memdot, pending, wait or _CONTINUE_WAIT_SECONDS)
        if not collected:
            emit(
                data={
                    "connected": False,
                    "state": "pending",
                    "url": pending["url"],
                    "code": pending["code"],
                },
                text=lambda: click.echo(f"Still waiting for you to approve it at {pending['url']}"),
            )
            return
        _emit_connected(collected, _finish_login(file, api_url, pending, collected), welcome=False)
        return

    identity, public_key = new_agent_identity()
    started = memdot.agents.start_connect(public_key=public_key, label=label, client=_client_name())
    pending = {
        "id": started.id,
        "code": started.code,
        "url": started.url,
        "poll_secret": started.poll_secret,
        "expires_at": started.expires_at,
        "identity": identity,
        "public_key": public_key,
        "label": label,
    }

    # For somewhere else: a server, n8n, CI. Nothing here changes, and it's revoked on its own.
    if print_env:
        click.echo(f"\nOpen {started.url}", err=True)
        click.echo(f"and type this code: {strong(started.code)}\n", err=True)
        if not no_browser:
            _open_browser(started.url)
        say(dim("Waiting for you to approve it…"))
        collected = _collect(memdot, pending, _LOGIN_WAIT_SECONDS)
        if not collected:
            raise CliError(
                "Nothing came back in time. Run this again.", EXIT["auth"], "CONNECT_EXPIRED"
            )
        env = {
            "MEMDOT_API_URL": api_url,
            "MEMDOT_API_KEY": collected["api_key"],
            "MEMDOT_AGENT_IDENTITY": identity,
            **(
                {"MEMDOT_NAMESPACE": collected["namespace_id"]}
                if collected.get("namespace_id")
                else {}
            ),
        }

        # On stdout and nothing else, so it can go straight into a file.
        def show_env() -> None:
            for name, value in env.items():
                click.echo(f"{name}={value}")

        emit(data=env, text=show_env)
        return

    creds.save_credentials(
        {**creds.for_api(file, api_url), "version": 1, "api_url": api_url, "pending": pending}
    )

    # A coding agent's shell shows nothing until the command ends, so it gets the address first and
    # collects afterwards.
    if no_wait or not interactive():

        def show() -> None:
            click.echo(f"Open {started.url}")
            click.echo(f"Type this code there: {strong(started.code)}")
            click.echo("Then come back and run:")
            click.echo("  memdot login --continue")

        emit(
            data={
                "connected": False,
                "state": "pending",
                "url": started.url,
                "code": started.code,
                "expires_at": started.expires_at,
                "next": "memdot login --continue --wait 120",
            },
            text=show,
        )
        return

    click.echo(f"\nOpen {started.url}", err=True)
    click.echo(f"and type this code: {strong(started.code)}\n", err=True)
    if not no_browser:
        _open_browser(started.url)
    say(dim("Waiting for you to approve it…"))
    collected = _collect(memdot, pending, _LOGIN_WAIT_SECONDS)
    if not collected:
        raise CliError(
            "Nothing came back in time. Run memdot login again.", EXIT["auth"], "CONNECT_EXPIRED"
        )
    synced = _finish_login(creds.load_credentials(), api_url, pending, collected)
    _emit_connected(collected, synced, welcome=True)


_SETTABLE = ("api_url", "namespace_id", "user_id", "agent_id", "run_id")


def register(root: click.Group) -> None:
    @root.command(
        "login", help="Connect this machine: you choose what it can reach, in your browser"
    )
    @click.option("--label", metavar="name", default=_default_label, help="what to call it")
    @click.option(
        "--with-key",
        metavar="key",
        help="use an API key you already have (Assisted only, no browser)",
    )
    @click.option("--no-browser", is_flag=True, help="just print the address")
    @click.option(
        "--no-wait", is_flag=True, help="print the address and return; finish later with --continue"
    )
    @click.option(
        "--continue", "resume", is_flag=True, help="collect a login started with --no-wait"
    )
    @click.option("--wait", metavar="seconds", type=float, help="how long --continue waits")
    @click.option(
        "--print-env",
        is_flag=True,
        help="connect somewhere else: print its credentials, and save nothing here",
    )
    @click.pass_context
    def login(ctx: click.Context, **options: Any) -> None:
        _run_login(ctx, **options)

    @root.command(
        "init", help="Set up this machine: the same as login, or --api-key to use a key you have"
    )
    @click.pass_context
    def init(ctx: click.Context) -> None:
        resolved = credentials_of(ctx)
        if resolved.api_key and resolved.api_key_source != "file":
            synced = _save_api_key(resolved.api_url, resolved.api_key, resolved.namespace_id)
            emit(
                data={
                    "connected": True,
                    "kind": "api_key",
                    "api_url": resolved.api_url,
                    "synced": synced,
                },
                text=lambda: click.echo(
                    f"{good('Connected.')} Saved to {creds.credentials_path()}"
                ),
            )
            return
        if resolved.api_key:
            emit(
                data={"connected": True, "kind": "existing", "api_url": resolved.api_url},
                text=lambda: click.echo(
                    "Already connected. To start over: memdot logout, then memdot login"
                ),
            )
            return
        _run_login(ctx, label=_default_label())

    @root.command(
        "logout", help="Forget this machine's key. It keeps working elsewhere until you revoke it"
    )
    def logout() -> None:
        creds.remove_credentials()
        emit(
            data={"logged_out": True},
            text=lambda: click.echo(
                "Forgotten here. To stop the key everywhere, revoke it under Agents."
            ),
        )

    @root.command("whoami", help="Who this machine is connected as")
    @click.pass_context
    def whoami(ctx: click.Context) -> None:
        file = creds.load_credentials() or {}
        memdot, resolved = connect(ctx)
        spaces = memdot.spaces.list()
        agent = file.get("agent")
        data = {
            "api_url": resolved.api_url,
            "key": _redact(resolved.api_key),
            "key_source": resolved.api_key_source,
            "agent": {"id": agent["id"], "label": agent["label"]} if agent else None,
            "reads_private": memdot.account.unlocked or bool(resolved.identity),
            "default_namespace_id": resolved.namespace_id,
            "spaces": [{"id": space.id, "name": space.name} for space in spaces],
        }

        def show() -> None:
            click.echo(strong(agent["label"] if agent else "An API key"))
            click.echo(dim(f"{data['key']} · {resolved.api_url}"))
            click.echo(
                "Holds its own key: it can read Private namespaces."
                if data["reads_private"]
                else "Holds no key: Assisted namespaces only."
            )
            for space in spaces:
                click.echo(f"  {space.name or '(sealed)'}  {dim(space.id)}")

        emit(data=data, text=show)

    @root.command("status", help="Whether MemDot is reachable and this key works")
    @click.pass_context
    def status(ctx: click.Context) -> None:
        resolved = credentials_of(ctx)
        started = time.perf_counter()
        try:
            reachable = httpx.get(f"{resolved.api_url.rstrip('/')}/live", timeout=20).is_success
        except httpx.HTTPError:
            reachable = False
        latency = round((time.perf_counter() - started) * 1000)
        key = "none"
        if reachable and resolved.api_key:
            memdot, _ = connect(ctx)
            try:
                memdot.usage()
                key = "valid"
            except MemDotError:
                key = "invalid"

        def show() -> None:
            first = good("Reachable") if reachable else "Unreachable"
            click.echo(f"{first}  {resolved.api_url}  {dim(f'{latency} ms')}")
            source = dim(f" (from {resolved.api_key_source})") if resolved.api_key_source else ""
            click.echo(f"Key: {key}{source}")

        emit(
            data={
                "api_url": resolved.api_url,
                "reachable": reachable,
                "latency_ms": latency,
                "key": key,
                "key_source": resolved.api_key_source,
                "version": VERSION,
            },
            text=show,
        )
        if not reachable:
            state.exit_code = EXIT["network"]
        elif key != "valid":
            state.exit_code = EXIT["auth"]

    @root.command("version", help="This CLI's version")
    def version() -> None:
        emit(data={"version": VERSION}, text=lambda: click.echo(VERSION))

    @root.group("config", help="What's saved on this machine")
    def config() -> None:
        pass

    @config.command("show", help="Show it, with keys hidden")
    def config_show() -> None:
        file = creds.load_credentials() or {}
        resolved = creds.resolve_credentials(file)
        agent = file.get("agent")
        emit(
            data={
                "path": str(creds.credentials_path()),
                "api_url": resolved.api_url,
                "api_key": _redact(resolved.api_key),
                "agent": {"id": agent["id"], "label": agent["label"]} if agent else None,
                "namespace_id": resolved.namespace_id,
                "user_id": resolved.user_id,
                "agent_id": resolved.agent_id,
                "run_id": resolved.run_id,
            }
        )

    def check_key(key: str) -> None:
        if key not in _SETTABLE:
            raise CliError(
                f"Unknown setting. Use {', '.join(_SETTABLE)}.", EXIT["usage"], "BAD_KEY"
            )

    @config.command("get", help="Read one setting")
    @click.argument("key", cls=Arg, help=", ".join(_SETTABLE))
    def config_get(key: str) -> None:
        check_key(key)
        value = getattr(creds.resolve_credentials(creds.load_credentials()), key)
        emit(data={"key": key, "value": value}, text=lambda: click.echo(value or ""))

    @config.command("set", help="Save one setting")
    @click.argument("key", cls=Arg, help=", ".join(_SETTABLE))
    @click.argument("value", cls=Arg)
    def config_set(key: str, value: str) -> None:
        check_key(key)
        file = creds.load_credentials() or {
            "version": 1,
            "api_url": creds.resolve_credentials(None).api_url,
        }
        if key == "api_url":
            file = {**creds.for_api(file, value), "api_url": value}
        elif key == "namespace_id":
            file[key] = value
        else:
            file["defaults"] = {**(file.get("defaults") or {}), key: value}
        creds.save_credentials(file)
        emit(data={"key": key, "value": value}, text=lambda: click.echo(f"{key} = {value}"))
