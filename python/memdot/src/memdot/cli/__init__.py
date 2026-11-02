"""The `memdot` command: the same commands, flags, envelope and exit codes as the Node CLI."""

from __future__ import annotations

import json
import os
import shlex
import sys
from pathlib import Path
from typing import Any

import click

from . import activity, memory, setup, storage
from .context import VERSION, Arg, credentials_of
from .output import EXIT, OUTPUT_MODES, CliError, emit, report_error, set_output, state

#: These can't be undone; a script or agent needs --force for them.
DESTRUCTIVE = {
    "delete",
    "file rm",
    "file revoke",
    "space rm",
    "folder rm",
    "entity rm",
    "agents revoke",
    "keys rotate",
    "keys revoke",
}
#: Commands that default to a table for people.
TABLE_FIRST = {
    "list",
    "file ls",
    "space ls",
    "folder ls",
    "namespace ls",
    "entity ls",
    "event ls",
    "job ls",
    "agents ls",
    "keys ls",
    "logs",
    "history",
    "file versions",
}
#: Accepted anywhere on the line, as Commander does. The value says whether it takes one.
_GLOBAL_FLAGS = {
    "--agent": False,
    "--json": False,
    "-o": True,
    "--output": True,
    "--api-key": True,
    "--api-url": True,
    "-n": True,
    "--namespace": True,
    "-u": True,
    "--user-id": True,
    "--agent-id": True,
    "--run-id": True,
}


def hoist_globals(argv: list[str]) -> list[str]:
    """Moves the global flags to the front, where the root group reads them."""
    hoisted: list[str] = []
    rest: list[str] = []
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--":
            rest.extend(argv[i:])
            break
        name = arg.split("=", 1)[0]
        short = arg[:2] if len(arg) > 2 and not arg.startswith("--") else None
        if name in _GLOBAL_FLAGS:
            hoisted.append(arg)
            if _GLOBAL_FLAGS[name] and "=" not in arg and i + 1 < len(argv):
                i += 1
                hoisted.append(argv[i])
        elif short in ("-o", "-n", "-u"):
            hoisted.append(arg)
        else:
            rest.append(arg)
        i += 1
    return hoisted + rest


def _full_name(ctx: click.Context) -> str:
    return " ".join(ctx.command_path.split(" ")[1:])


class Command(click.Command):
    def invoke(self, ctx: click.Context) -> Any:
        name = _full_name(ctx)
        root = ctx.find_root().params
        if root.get("agent") or root.get("json_"):
            mode = "json"
        else:
            mode = root.get("output") or ("table" if name in TABLE_FIRST else "text")
        set_output(mode, name)
        return super().invoke(ctx)


class Group(click.Group):
    command_class = Command
    group_class = type

    def list_commands(self, ctx: click.Context) -> list[str]:
        # The order they were added, the same as `help --json` from Node.
        return list(self.commands)


@click.group(
    "memdot",
    cls=Group,
    help="Encrypted storage and agent memory on Portaldot V3.",
    context_settings={"help_option_names": ["-h", "--help"]},
)
@click.version_option(VERSION, "-v", "--version", message="%(version)s", help="this CLI's version")
@click.option(
    "--agent", is_flag=True, help="answer as one JSON envelope on stdout, for agents and scripts"
)
@click.option("--json", "json_", is_flag=True, help="the same as --agent")
@click.option(
    "-o",
    "--output",
    metavar="mode",
    type=click.Choice(OUTPUT_MODES),
    envvar="MEMDOT_OUTPUT",
    help="how to answer",
)
# These also read MEMDOT_API_KEY and so on, later: a flag beats the environment beats the file.
@click.option("--api-key", metavar="key", help="use this key (or MEMDOT_API_KEY)")
@click.option("--api-url", metavar="url", help="use this API (or MEMDOT_API_URL)")
@click.option("-n", "--namespace", metavar="id", help="which namespace (or MEMDOT_NAMESPACE)")
@click.option("-u", "--user-id", metavar="id", help="who this is about (or MEMDOT_USER_ID)")
@click.option("--agent-id", metavar="id", help="which agent this belongs to (or MEMDOT_AGENT_ID)")
@click.option("--run-id", metavar="id", help="which session or run (or MEMDOT_RUN_ID)")
def cli(**_: Any) -> None:
    pass


memory.register(cli)
storage.register_files(cli)
storage.register_spaces(cli)
activity.register(cli)
setup.register(cli)


# ── MCP ──────────────────────────────────────────────────────────────────────────────────────

_MCP_FILES = {
    "claude-desktop": lambda: (
        Path(os.environ.get("APPDATA", str(Path.home()))) / "Claude" / "claude_desktop_config.json"
        if sys.platform == "win32"
        else Path.home() / "Library/Application Support/Claude/claude_desktop_config.json"
        if sys.platform == "darwin"
        else Path.home() / ".config/Claude/claude_desktop_config.json"
    ),
    "cursor": lambda: Path.home() / ".cursor/mcp.json",
}
_MCP_CLIENTS = ["claude-code", *_MCP_FILES]
_PRIVATE_FILE = 0o600


def _add_to_settings(path: Path, server: dict[str, Any]) -> None:
    """Adds our server and leaves the rest alone. The old file stays next to it, in case."""
    settings: dict[str, Any] = {}
    # Settings can hold other servers' tokens, so a new copy is never more readable than the old.
    mode = _PRIVATE_FILE
    try:
        raw = path.read_text("utf8")
        settings = json.loads(raw)
        mode = path.stat().st_mode & 0o777
        backup = path.with_name(f"{path.name}.bak")
        descriptor = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
        with os.fdopen(descriptor, "w", encoding="utf8") as file:
            os.fchmod(file.fileno(), mode)
            file.write(raw)
    except FileNotFoundError:
        path.parent.mkdir(parents=True, exist_ok=True)
    except (OSError, ValueError) as error:
        raise CliError(
            f"{path} isn't valid JSON, so it was left alone.", EXIT["conflict"], "BAD_SETTINGS"
        ) from error
    settings["mcpServers"] = {**settings.get("mcpServers", {}), "memdot": server}
    temporary = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
        with os.fdopen(descriptor, "w", encoding="utf8") as file:
            file.write(json.dumps(settings, indent=2, ensure_ascii=False) + "\n")
        temporary.replace(path)
    except OSError:
        temporary.unlink(missing_ok=True)
        raise


@cli.group(
    "mcp",
    invoke_without_command=True,
    help="Run the local MCP server over stdio, or set a client up to use it",
)
@click.pass_context
def mcp(ctx: click.Context) -> None:
    if ctx.invoked_subcommand is None:
        from ..mcp_server import serve_local

        serve_local()


@mcp.command(
    "config", help="What a client needs to use MemDot; --write adds it to the client's settings"
)
@click.option("--client", metavar="name", default="claude-desktop", help=", ".join(_MCP_CLIENTS))
@click.option(
    "--hosted", is_flag=True, help="the hosted server: Assisted namespaces, signs in with OAuth"
)
@click.option("--write", is_flag=True, help="add it to that client's settings file")
@click.pass_context
def mcp_config(ctx: click.Context, client: str, hosted: bool, write: bool) -> None:
    if client not in _MCP_CLIENTS:
        raise CliError(
            f"Unknown client. Use {', '.join(_MCP_CLIENTS)}.", EXIT["usage"], "BAD_CLIENT"
        )
    api_url = credentials_of(ctx).api_url
    # Full paths: an app started from the dock doesn't have your shell's PATH.
    python = sys.executable
    server: dict[str, Any] = (
        {"type": "http", "url": f"{api_url}/mcp"}
        if hosted
        else {"command": python, "args": ["-m", "memdot.cli", "mcp"]}
    )
    if client == "claude-code":
        line = (
            f"claude mcp add --transport http memdot {shlex.quote(f'{api_url}/mcp')}"
            if hosted
            else f"claude mcp add memdot -- {shlex.quote(python)} -m memdot.cli mcp"
        )
        emit(data={"client": client, "run": line}, text=lambda: click.echo(line))
        return
    path = _MCP_FILES[client]()
    if write:
        _add_to_settings(path, server)
    config = {"mcpServers": {"memdot": server}}

    def show() -> None:
        if write:
            click.echo(f"Added to {path}. Restart the app to pick it up.")
            return
        click.echo(f"Add this to {path}, or run this again with --write:\n")
        click.echo(json.dumps(config, indent=2))

    emit(data={"client": client, "where": str(path), "written": write, "config": config}, text=show)


# ── Help ─────────────────────────────────────────────────────────────────────────────────────


def _flags_of(option: click.Option) -> str:
    flags = ", ".join(option.opts)
    takes_value = not option.is_flag and option.metavar
    return f"{flags} <{option.metavar}>" if takes_value else flags


def _describe(command: click.Command, ctx: click.Context) -> dict[str, Any]:
    name = " ".join(ctx.command_path.split(" ")[1:])
    described: dict[str, Any] = {"name": name or command.name, "description": command.help}
    if name in DESTRUCTIVE:
        described.update(destructive=True, confirm_flag="--force")
    described["arguments"] = [
        {
            "name": (param.metavar or param.name or "").removesuffix("..."),
            "required": param.required,
            "description": getattr(param, "help", None),
        }
        for param in command.params
        if isinstance(param, click.Argument)
    ]
    options = []
    for param in command.params:
        if not isinstance(param, click.Option) or param.name == "help":
            continue
        option: dict[str, Any] = {"flags": _flags_of(param), "description": param.help or ""}
        if isinstance(param.default, (str, int, float)) and not param.is_flag:
            option["default"] = param.default
        if isinstance(param.type, click.Choice):
            option["choices"] = list(param.type.choices)
        if param.envvar:
            option["env"] = param.envvar
        options.append(option)
    described["options"] = options
    if isinstance(command, click.Group):
        children = []
        for child_name in command.list_commands(ctx):
            child = command.get_command(ctx, child_name)
            if child and child_name != "help":
                children.append(
                    _describe(child, click.Context(child, info_name=child_name, parent=ctx))
                )
        if children:
            described["subcommands"] = children
    return described


@cli.command("help", help="Show the commands; --json for all of them, for an agent to read")
@click.argument("names", metavar="command...", nargs=-1, cls=Arg, help="a command to explain")
@click.option("--json", "tree", is_flag=True, help="the whole tree as JSON")
@click.pass_context
def help_command(ctx: click.Context, names: tuple[str, ...], tree: bool) -> None:
    root_ctx = ctx.find_root()
    if tree or root_ctx.params.get("json_") or root_ctx.params.get("agent"):
        click.echo(
            json.dumps(
                {
                    "exit_codes": EXIT,
                    "envelope": {
                        "success": {
                            "status": "success",
                            "command": "",
                            "duration_ms": 0,
                            "count": 0,
                            "data": {},
                        },
                        "error": {
                            "status": "error",
                            "command": "",
                            "error": {"code": "", "message": ""},
                            "data": None,
                        },
                    },
                    **_describe(cli, click.Context(cli, info_name="memdot")),
                },
                indent=2,
                ensure_ascii=False,
            )
        )
        return
    at: click.Command = cli
    at_ctx = click.Context(cli, info_name="memdot")
    for name in names:
        following = at.get_command(at_ctx, name) if isinstance(at, click.Group) else None
        if not following:
            raise CliError(f"No such command: {' '.join(names)}", EXIT["usage"], "NO_COMMAND")
        at, at_ctx = following, click.Context(following, info_name=name, parent=at_ctx)
    click.echo(at.get_help(at_ctx))


def main(argv: list[str] | None = None) -> None:
    raw = list(sys.argv[1:] if argv is None else argv)
    # Before a subcommand is chosen, a usage error still has to come back as JSON if asked for.
    if "--agent" in raw or "--json" in raw:
        set_output("json", raw[0] if raw else "memdot")
    try:
        result = cli.main(args=hoist_globals(raw), prog_name="memdot", standalone_mode=False)
        code = result if isinstance(result, int) else state.exit_code
    except click.exceptions.Exit as leaving:
        code = leaving.exit_code
    except click.Abort:
        code = EXIT["failed"]
    except click.ClickException as error:
        code = report_error(CliError(error.format_message(), EXIT["usage"], "USAGE"))
    except CliError as error:
        if error.code == "CANCELLED":
            emit(data={"cancelled": True}, text=lambda: click.echo("Cancelled."))
            code = EXIT["ok"]
        else:
            code = report_error(error)
    except Exception as error:
        code = report_error(error)
    sys.exit(code)


__all__ = ["cli", "main"]
