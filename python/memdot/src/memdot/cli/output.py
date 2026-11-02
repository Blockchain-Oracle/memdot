"""How the CLI answers: one JSON envelope for agents and scripts, or text and tables for people."""

from __future__ import annotations

import json
import math
import sys
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

import click

from ..errors import LockedError, MemDotError, NetworkError

OUTPUT_MODES = ("text", "json", "table", "quiet")

#: Distinct codes, so a script can tell "sign in" from "not found" from "try again".
EXIT = {
    "ok": 0,
    "failed": 1,
    "usage": 2,
    "auth": 3,
    "notFound": 4,
    "conflict": 5,
    "limited": 6,
    "network": 7,
}


class CliError(Exception):
    def __init__(
        self,
        message: str,
        exit_code: int = EXIT["failed"],
        code: str = "FAILED",
        hint: str | None = None,
    ) -> None:
        super().__init__(message)
        self.exit_code = exit_code
        self.code = code
        self.hint = hint


@dataclass
class Column:
    header: str
    value: Callable[[Any], str]
    #: Long values are cut to this width in tables.
    max: int | None = None


class _State:
    mode = "text"
    command = "memdot"
    started = time.perf_counter()
    exit_code = EXIT["ok"]


state = _State()


def set_output(mode: str, command: str) -> None:
    state.mode = mode
    state.command = command


def interactive() -> bool:
    """Whether a person is at this run, able to answer a prompt or read a progress line."""
    return state.mode in ("text", "table") and sys.stdin.isatty()


def say(line: str) -> None:
    if state.mode in ("text", "table"):
        click.echo(line, err=True)


def dim(text: str) -> str:
    return click.style(text, dim=True)


def strong(text: str) -> str:
    return click.style(text, bold=True)


def good(text: str) -> str:
    return click.style(text, fg="green")


def as_json(value: Any) -> Any:
    """Models as the same names the Node CLI prints; the rest as it is."""
    if hasattr(value, "to_dict"):
        return value.to_dict()
    if isinstance(value, list):
        return [as_json(item) for item in value]
    if isinstance(value, dict):
        return {key: as_json(item) for key, item in value.items()}
    return value


def _dumps(value: Any, indent: int | None = 2) -> str:
    return json.dumps(as_json(value), indent=indent, ensure_ascii=False)


def _print_table(rows: list[Any], columns: list[Column]) -> None:
    def cut(value: str, limit: int | None) -> str:
        return f"{value[: limit - 1]}…" if limit and len(value) > limit else value

    cells = [
        [cut(column.value(row).replace("\n", " "), column.max) for column in columns]
        for row in rows
    ]
    widths = [
        max([len(column.header), *(len(row[i]) for row in cells)])
        for i, column in enumerate(columns)
    ]

    def line(values: list[str]) -> str:
        return "  ".join(
            value if i == len(values) - 1 else value.ljust(widths[i])
            for i, value in enumerate(values)
        )

    click.echo(strong(line([column.header for column in columns])))
    for row in cells:
        click.echo(line(row))


def _clean_scope(scope: dict[str, Any] | None) -> dict[str, Any] | None:
    kept = {key: value for key, value in (scope or {}).items() if value}
    return kept or None


def emit(
    *,
    data: Any,
    count: int | None = None,
    scope: dict[str, Any] | None = None,
    text: Callable[[], None] | None = None,
    table: tuple[list[Any], list[Column]] | None = None,
) -> None:
    """Prints a command's result. In json mode, stdout holds this one envelope and nothing else."""
    if state.mode == "quiet":
        return
    if state.mode == "json":
        envelope: dict[str, Any] = {
            "status": "success",
            "command": state.command,
            "duration_ms": math.floor((time.perf_counter() - state.started) * 1000 + 0.5),
        }
        cleaned = _clean_scope(scope)
        if cleaned:
            envelope["scope"] = cleaned
        if count is not None:
            envelope["count"] = count
        envelope["data"] = data
        click.echo(_dumps(envelope))
        return
    if state.mode == "table":
        if table:
            _print_table(*table)
        else:
            click.echo(_dumps(data))
        return
    if text:
        text()
    elif table:
        if not table[0]:
            click.echo("Nothing here yet.")
        else:
            _print_table(*table)
    else:
        click.echo(_dumps(data))


def _classify(error: Exception) -> dict[str, Any]:
    if isinstance(error, CliError):
        return {
            "exit": error.exit_code,
            "code": error.code,
            "message": str(error),
            "hint": error.hint,
        }
    if isinstance(error, LockedError):
        return {
            "exit": EXIT["conflict"],
            "code": "OWNER_KEYS_NEEDED",
            "message": "This takes the owner's keys, which an agent doesn't hold.",
            "hint": "Do it in the dashboard, or set MEMDOT_RECOVERY_CODE for this one command.",
        }
    if isinstance(error, NetworkError):
        return {
            "exit": EXIT["network"],
            "code": "NETWORK",
            "message": "Couldn't reach MemDot. Check your connection or --api-url.",
        }
    if isinstance(error, MemDotError):
        exit_code = {
            401: EXIT["auth"],
            403: EXIT["auth"],
            404: EXIT["notFound"],
            409: EXIT["conflict"],
            423: EXIT["conflict"],
            429: EXIT["limited"],
            400: EXIT["usage"],
            422: EXIT["usage"],
        }.get(error.status, EXIT["failed"])
        return {
            "exit": exit_code,
            "code": error.code,
            "message": error.message,
            "request_id": error.request_id,
            "hint": "This key was revoked or has expired. Connect again with: memdot login"
            if error.status == 401
            else None,
        }
    return {"exit": EXIT["failed"], "code": "FAILED", "message": str(error)}


def report_error(error: Exception) -> int:
    """Reports a failure the way this run's mode expects, and gives the exit code to leave with."""
    found = _classify(error)
    if state.mode == "json":
        described = {"code": found["code"], "message": found["message"]}
        if found.get("hint"):
            described["hint"] = found["hint"]
        if found.get("request_id"):
            described["request_id"] = found["request_id"]
        click.echo(
            json.dumps(
                {
                    "status": "error",
                    "command": state.command,
                    "error": described,
                    "data": None,
                },
                ensure_ascii=False,
            )
        )
        return found["exit"]
    click.echo(click.style(f"Error: {found['message']}", fg="red"), err=True)
    if found.get("hint"):
        click.echo(found["hint"], err=True)
    if found.get("request_id"):
        click.echo(dim(f"Request {found['request_id']}"), err=True)
    return found["exit"]
