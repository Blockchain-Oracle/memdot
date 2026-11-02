"""What every command shares: the connected client, the scope, and the checks before it acts."""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

import click

from .. import credentials as creds
from .._constants import __version__
from .._sync.client import MemDot
from .output import EXIT, CliError, interactive

VERSION = __version__
CLIENT = os.environ.get("MEMDOT_CLIENT", "").strip() or f"cli-py/{VERSION}"
_FLAGS = ("api_key", "api_url", "namespace", "user_id", "agent_id", "run_id")


class Arg(click.Argument):
    """An argument that says what it is, for `help --json`."""

    def __init__(self, *args: Any, help: str | None = None, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.help = help


def globals_of(ctx: click.Context) -> dict[str, Any]:
    root = ctx.find_root().params
    return {name: root.get(name) for name in _FLAGS}


def credentials_of(ctx: click.Context) -> creds.ResolvedCredentials:
    return creds.resolve_credentials(creds.load_credentials(), globals_of(ctx))


def client_for(resolved: creds.ResolvedCredentials) -> MemDot:
    """With an agent identity it opens what was shared with that agent; with
    `MEMDOT_RECOVERY_CODE` it acts as the owner."""
    memdot = MemDot(
        resolved.api_key,
        base_url=resolved.api_url,
        client=CLIENT,
        identity=resolved.identity,
        namespace_id=resolved.namespace_id,
        complete_grants_on_unlock=False,
    )
    if resolved.recovery_code:
        memdot.account.unlock_with_recovery_code(resolved.recovery_code)
    return memdot


def connect(ctx: click.Context) -> tuple[MemDot, creds.ResolvedCredentials]:
    """A connected client, or a clear next step when this machine isn't connected yet."""
    resolved = credentials_of(ctx)
    if not resolved.api_key and not resolved.recovery_code:
        raise CliError(
            "This machine isn't connected to MemDot.",
            EXIT["auth"],
            "NOT_CONNECTED",
            "Run: memdot login",
        )
    return client_for(resolved), resolved


def named_scope(ctx: click.Context) -> dict[str, str]:
    """The scope named on this run. Reads and deletes use only this, never a saved default."""
    flags = globals_of(ctx)
    return {key: flags[key] for key in ("user_id", "agent_id", "run_id") if flags[key]}


def scope_of(ctx: click.Context, resolved: creds.ResolvedCredentials) -> dict[str, str]:
    """Who a new memory is about: what's named on this run, or else the saved defaults.

    Mixing the two would file it under a default the caller didn't ask for.
    """
    named = named_scope(ctx)
    if named:
        return named
    saved = {"user_id": resolved.user_id, "agent_id": resolved.agent_id, "run_id": resolved.run_id}
    return {key: value for key, value in saved.items() if value}


def parse_json(raw: str, what: str) -> Any:
    try:
        return json.loads(raw)
    except ValueError as error:
        raise CliError(f"{what} isn't valid JSON.", EXIT["usage"], "BAD_JSON") from error


def parse_integer(raw: Any) -> int:
    try:
        value = int(raw)
    except ValueError as error:
        raise CliError(f'"{raw}" isn\'t a whole number.', EXIT["usage"], "BAD_NUMBER") from error
    if value < 0:
        raise CliError(f'"{raw}" isn\'t a whole number.', EXIT["usage"], "BAD_NUMBER")
    return value


def parse_fraction(raw: Any) -> float:
    try:
        value = float(raw)
    except ValueError as error:
        raise CliError(f'"{raw}" isn\'t between 0 and 1.', EXIT["usage"], "BAD_NUMBER") from error
    if not 0 <= value <= 1:
        raise CliError(f'"{raw}" isn\'t between 0 and 1.', EXIT["usage"], "BAD_NUMBER")
    return value


def read_stdin() -> str | None:
    """Text from stdin, when something is piped in. Never waits on a terminal or in agent mode."""
    if sys.stdin.isatty():
        return None
    return sys.stdin.read().strip() or None


def confirm_destructive(message: str, force: bool) -> None:
    """Stops anything that can't be undone unless the person said so.

    A script or agent has to pass --force; a person gets asked, and anything but yes leaves it alone.
    """
    if force:
        return
    if not interactive():
        raise CliError(
            f"{message} Pass --force to go ahead.", EXIT["conflict"], "CONFIRMATION_REQUIRED"
        )
    click.echo(f"{message} This can't be undone. [y/N] ", nl=False, err=True)
    if sys.stdin.readline().strip().lower() != "y":
        raise CliError("Cancelled.", EXIT["ok"], "CANCELLED")


def space_of(memdot: MemDot, named: str | None) -> str:
    """The space to use: named, or the only one this key can reach."""
    if named:
        return named
    spaces = memdot.spaces.list()
    if len(spaces) == 1:
        return spaces[0].id
    listed = ", ".join(f"{s.id} ({s.name or 'unnamed'})" for s in spaces)
    raise CliError(
        "There's no space here yet. Create one in the dashboard."
        if not spaces
        else f"Pick a space with --space: {listed}",
        EXIT["usage"],
        "SPACE_REQUIRED",
    )


def read_text(path: str) -> str:
    try:
        return Path(path).read_text("utf8")
    except OSError as error:
        raise CliError(
            f"Couldn't read {path}: {error.strerror}", EXIT["usage"], "BAD_FILE"
        ) from error
