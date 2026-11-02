"""Files, spaces, folders and namespaces."""

from __future__ import annotations

import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import click

from .._constants import TPOT_DECIMALS
from .context import Arg, confirm_destructive, connect, parse_integer, space_of
from .output import EXIT, CliError, Column, dim, emit, good, say

_DEFAULT_PAGE = 50
_FILE_COLUMNS = [
    Column("ID", lambda f: f.id),
    Column("Name", lambda f: f.name or "(sealed)", 40),
    Column("Size", lambda f: "" if f.size is None else str(f.size)),
    Column("Status", lambda f: f.status or ""),
    Column("CID", lambda f: f.cid or "", 24),
]


def _format_tpot(planck: int, digits: int = 4) -> str:
    unit = 10**TPOT_DECIMALS
    fraction = str(planck % unit).rjust(TPOT_DECIMALS, "0")[:digits]
    return f"{planck // unit}.{fraction} tPOT"


def _expires_at(days: int | None) -> str | None:
    if not days:
        return None
    return (datetime.now(timezone.utc) + timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%S.000Z")


def register_files(root: click.Group) -> None:
    @root.group("file", help="Encrypted files on Portaldot V3")
    def file() -> None:
        pass

    @file.command("put", help="Encrypt a file here and store it")
    @click.argument("path", cls=Arg)
    @click.option("--space", metavar="id", help="which space (default: the only one you can reach)")
    @click.option("--folder", metavar="id", help="which folder")
    @click.option("--name", metavar="name", help="what to call it (default: the file's own name)")
    @click.option("--mime", metavar="type", help="its type")
    @click.option("--replaces", metavar="id", help="store this as a new version of that file")
    @click.option("--dry-run", is_flag=True, help="say what it would cost, and store nothing")
    @click.option("--no-wait", is_flag=True, help="return once it's queued, before it's on chain")
    @click.pass_context
    def put(ctx: click.Context, path: str, **options: Any) -> None:
        memdot, _ = connect(ctx)
        try:
            size = os.stat(path).st_size
        except OSError as error:
            raise CliError(
                f"Couldn't read {path}: {error.strerror}", EXIT["usage"], "BAD_FILE"
            ) from error
        if options["dry_run"]:
            estimate = memdot.files.estimate(size)
            planck = estimate["planck"]
            emit(
                data={
                    "dry_run": True,
                    "size": size,
                    "blobs": estimate["blobs"],
                    "planck": str(planck),
                    "tpot": _format_tpot(planck),
                },
                text=lambda: click.echo(
                    f"{size} bytes, {estimate['blobs']} blobs, about {_format_tpot(planck)}.\n"
                    "Nothing stored."
                ),
            )
            return
        space_id = space_of(memdot, options["space"])
        name = options["name"] or Path(path).name
        say(dim(f"Encrypting {name}…"))
        result = memdot.files.put(
            Path(path).read_bytes(),
            space_id=space_id,
            name=name,
            folder_id=options["folder"],
            mime=options["mime"] or "application/octet-stream",
            previous_version_id=options["replaces"],
            wait=not options["no_wait"],
            on_progress=lambda update: say(dim(f"  {update.status}")),
        )
        stored, job = result.file, result.job

        def show() -> None:
            click.echo(f"{good('Stored')} {name}  {dim(stored.id)}")
            if stored.cid:
                click.echo(dim(f"CID {stored.cid}"))

        emit(
            data={
                "id": stored.id,
                "name": name,
                "cid": stored.cid,
                "status": job.status,
                "job_id": job.id,
                "tx_hash": job.tx_hash,
                "block": job.block,
            },
            text=show,
        )

    @file.command("get", help="Fetch a file and decrypt it here")
    @click.argument("file_id", metavar="id", cls=Arg)
    @click.option("-O", "--out", metavar="path", help="where to write it (default: its own name)")
    @click.option("--stdout", "to_stdout", is_flag=True, help="write the bytes to stdout")
    @click.pass_context
    def get(ctx: click.Context, file_id: str, out: str | None, to_stdout: bool) -> None:
        memdot, _ = connect(ctx)
        opened = memdot.files.get(file_id)
        if to_stdout:
            click.get_binary_stream("stdout").write(opened.data)
            return
        target = out or Path(opened.name).name
        try:
            with open(target, "xb") as written:
                written.write(opened.data)
        except FileExistsError as error:
            raise CliError(f"{target} already exists.", EXIT["conflict"], "FILE_EXISTS") from error
        emit(
            data={
                "id": file_id,
                "name": opened.name,
                "mime": opened.mime,
                "size": len(opened.data),
                "out": target,
            },
            text=lambda: click.echo(f"Wrote {target} ({len(opened.data)} bytes)."),
        )

    @file.command("ls", help="List files, names decrypted here")
    @click.option("--space", metavar="id")
    @click.option("--folder", metavar="id")
    @click.option(
        "--limit", metavar="n", type=parse_integer, default=_DEFAULT_PAGE, help="how many"
    )
    @click.option("--cursor", metavar="cursor")
    @click.pass_context
    def ls(ctx: click.Context, **options: Any) -> None:
        memdot, _ = connect(ctx)
        page = memdot.files.list(
            space_id=options["space"],
            folder_id=options["folder"],
            limit=options["limit"],
            cursor=options["cursor"],
        )
        emit(
            count=len(page.items),
            data={
                "next_cursor": page.next_cursor,
                "files": [
                    {
                        "id": row.id,
                        "name": row.name,
                        "mime": row.mime,
                        "size": row.size,
                        "status": row.status,
                        "cid": row.cid,
                        "folder_id": row.folder_id,
                        "created_at": row.created_at,
                    }
                    for row in page.items
                ],
            },
            table=(page.items, _FILE_COLUMNS),
        )

    @file.command("verify", help="Check a file against the chain, from this machine")
    @click.argument("file_id", metavar="id", cls=Arg)
    @click.pass_context
    def verify(ctx: click.Context, file_id: str) -> None:
        memdot, _ = connect(ctx)
        say(dim("Asking Portaldot V3…"))
        result = memdot.files.verify(file_id)
        # A node can stall on a cold connection; "inconclusive" means ask again.
        if result.inconclusive:
            result = memdot.files.verify(file_id)
        memdot.close()
        if not result.ok and not result.inconclusive:
            raise CliError("The chain doesn't match this file.", EXIT["failed"], "VERIFY_FAILED")
        emit(
            data=result,
            text=lambda: click.echo(
                f"{good('Verified')}: {len(result.blobs)} blobs hash to their CIDs on V3."
                if result.ok
                else "A node didn't answer in time, so this says nothing either way. Try again."
            ),
        )

    @file.command("share", help="Share a file or a space, which takes the owner's keys")
    @click.argument(
        "file_id",
        metavar="id",
        required=False,
        cls=Arg,
        help="a file; or use --space for a whole space",
    )
    @click.option("--space", metavar="id", help="share this whole space instead")
    @click.option("--to", metavar="address", help="someone's Portaldot or EVM address")
    @click.option("--to-agent", metavar="id", help="a connected agent")
    @click.option("--scope", metavar="scope", default="read", help="read or read_write")
    @click.option(
        "--expires-days", metavar="n", type=parse_integer, help="stop working after this many days"
    )
    @click.pass_context
    def share(ctx: click.Context, file_id: str | None, **options: Any) -> None:
        if bool(file_id) == bool(options["space"]):
            raise CliError("Give a file id, or --space.", EXIT["usage"], "BAD_ARGS")
        if bool(options["to"]) == bool(options["to_agent"]):
            raise CliError("Give --to or --to-agent.", EXIT["usage"], "BAD_ARGS")
        memdot, _ = connect(ctx)
        if options["to_agent"]:
            agent = next((a for a in memdot.agents.list() if a.id == options["to_agent"]), None)
            if not agent or not agent.public_key:
                raise CliError("That agent can't receive keys.", EXIT["notFound"], "AGENT")
            to = {"agent_id": agent.id, "agent_key": agent.public_key}
        else:
            to = {"address": options["to"]}
        grant_options: dict[str, Any] = {
            "scope": options["scope"],
            "expires_at": _expires_at(options["expires_days"]),
        }
        grant = (
            memdot.sharing.share_space(options["space"], to, **grant_options)
            if options["space"]
            else memdot.sharing.share_file(file_id or "", to, **grant_options)
        )
        emit(
            data={"grant_id": grant.id, "status": grant.status, "scope": grant.scope},
            text=lambda: click.echo(
                f"Waiting: it completes once they've set up MemDot. Grant {grant.id}"
                if grant.status == "pending"
                else f"Shared. Grant {grant.id}"
            ),
        )

    @file.command("revoke", help="Stop a share; future writes use a key they never get")
    @click.argument("grant_id", metavar="grantId", cls=Arg)
    @click.option("--force", is_flag=True, help="don't ask")
    @click.pass_context
    def revoke(ctx: click.Context, grant_id: str, force: bool) -> None:
        confirm_destructive(f"Revoke grant {grant_id}?", force)
        memdot, _ = connect(ctx)
        memdot.sharing.revoke(grant_id)
        emit(
            data={"grant_id": grant_id, "revoked": True},
            text=lambda: click.echo("Revoked. Anything they already opened may have been kept."),
        )

    @file.command("rm", help="Delete a file; its bytes leave the chain within 7 days")
    @click.argument("file_id", metavar="id", cls=Arg)
    @click.option("--force", is_flag=True, help="don't ask")
    @click.pass_context
    def rm(ctx: click.Context, file_id: str, force: bool) -> None:
        memdot, _ = connect(ctx)
        confirm_destructive(f"Delete {file_id}? Memories learned from it go too.", force)
        memdot.files.delete(file_id)
        emit(data={"id": file_id, "deleted": True}, text=lambda: click.echo("Deleted."))

    @file.command("renew", help="Renew a file now, without waiting for the keeper")
    @click.argument("file_id", metavar="id", cls=Arg)
    @click.option("--no-wait", is_flag=True, help="return once it's queued")
    @click.pass_context
    def renew(ctx: click.Context, file_id: str, no_wait: bool) -> None:
        memdot, _ = connect(ctx)
        job = memdot.files.renew(file_id, wait=not no_wait)
        emit(
            data={
                "job_id": job.id,
                "status": job.status,
                "tx_hash": job.tx_hash,
                "block": job.block,
            },
            text=lambda: click.echo(f"Renewal {job.status}."),
        )

    @file.command("versions", help="Every version of a file")
    @click.argument("file_id", metavar="id", cls=Arg)
    @click.pass_context
    def versions(ctx: click.Context, file_id: str) -> None:
        memdot, _ = connect(ctx)
        rows = memdot.files.versions(file_id)
        emit(
            count=len(rows),
            data=[
                {
                    "id": row.id,
                    "name": row.name,
                    "size": row.size,
                    "status": row.status,
                    "cid": row.cid,
                    "created_at": row.created_at,
                }
                for row in rows
            ],
            table=(rows, _FILE_COLUMNS),
        )


def register_spaces(root: click.Group) -> None:
    @root.group("space", help="Spaces: where files and namespaces live")
    def space() -> None:
        pass

    @space.command("ls", help="List the spaces this key can reach")
    @click.pass_context
    def space_ls(ctx: click.Context) -> None:
        memdot, _ = connect(ctx)
        rows = memdot.spaces.list()
        emit(
            count=len(rows),
            data=[
                {
                    "id": row.id,
                    "name": row.name,
                    "mode": row.mode,
                    "used_bytes": row.used_bytes,
                    "quota_bytes": row.quota_bytes,
                }
                for row in rows
            ],
            table=(
                rows,
                [
                    Column("ID", lambda r: r.id),
                    Column("Name", lambda r: r.name or "(sealed)", 40),
                    Column("Mode", lambda r: r.mode),
                    Column("Used", lambda r: f"{r.used_bytes} / {r.quota_bytes}"),
                ],
            ),
        )

    @space.command("get", help="Read one space")
    @click.argument("space_id", metavar="id", cls=Arg)
    @click.pass_context
    def space_get(ctx: click.Context, space_id: str) -> None:
        memdot, _ = connect(ctx)
        emit(data=memdot.spaces.get(space_id))

    @space.command("create", help="Create a space, which takes the owner's keys")
    @click.argument("name", cls=Arg)
    @click.option("--self-signed", is_flag=True, help="your wallet signs each store")
    @click.pass_context
    def space_create(ctx: click.Context, name: str, self_signed: bool) -> None:
        memdot, _ = connect(ctx)
        created = memdot.spaces.create(name, mode="self_signed" if self_signed else "sponsored")
        emit(data=created, text=lambda: click.echo(f"Created {created.id}"))

    @space.command("rename", help="Rename a space")
    @click.argument("space_id", metavar="id", cls=Arg)
    @click.argument("name", cls=Arg)
    @click.pass_context
    def space_rename(ctx: click.Context, space_id: str, name: str) -> None:
        memdot, _ = connect(ctx)
        emit(data=memdot.spaces.rename(space_id, name), text=lambda: click.echo("Renamed."))

    @space.command("rm", help="Delete a space and everything in it")
    @click.argument("space_id", metavar="id", cls=Arg)
    @click.option("--force", is_flag=True, help="don't ask")
    @click.pass_context
    def space_rm(ctx: click.Context, space_id: str, force: bool) -> None:
        memdot, _ = connect(ctx)
        confirm_destructive(f"Delete space {space_id} and everything in it?", force)
        memdot.spaces.delete(space_id)
        emit(data={"id": space_id, "deleted": True}, text=lambda: click.echo("Deleted."))

    @root.group("folder", help="Folders inside a space")
    def folder() -> None:
        pass

    @folder.command("ls", help="List folders in a space")
    @click.option("--space", metavar="id")
    @click.pass_context
    def folder_ls(ctx: click.Context, space: str | None) -> None:
        memdot, _ = connect(ctx)
        rows = memdot.folders.list(space_of(memdot, space))
        emit(
            count=len(rows),
            data=[
                {
                    "id": row.id,
                    "name": row.name,
                    "parent_id": row.parent_id,
                    "memory_mode": row.memory_mode,
                }
                for row in rows
            ],
            table=(
                rows,
                [
                    Column("ID", lambda r: r.id),
                    Column("Name", lambda r: r.name or "(sealed)", 40),
                    Column("Memory", lambda r: r.memory_mode),
                ],
            ),
        )

    @folder.command("create", help="Create a folder; its name is sealed here")
    @click.argument("name", cls=Arg)
    @click.option("--space", metavar="id")
    @click.option("--parent", metavar="id")
    @click.pass_context
    def folder_create(ctx: click.Context, name: str, space: str | None, parent: str | None) -> None:
        memdot, _ = connect(ctx)
        created = memdot.folders.create(space_of(memdot, space), name, parent_id=parent)
        emit(data=created, text=lambda: click.echo(f"Created {created.id}"))

    @folder.command("rename", help="Rename a folder")
    @click.argument("folder_id", metavar="id", cls=Arg)
    @click.argument("name", cls=Arg)
    @click.option("--space", metavar="id")
    @click.pass_context
    def folder_rename(ctx: click.Context, folder_id: str, name: str, space: str | None) -> None:
        memdot, _ = connect(ctx)
        renamed = memdot.folders.rename(folder_id, space_of(memdot, space), name)
        emit(data=renamed, text=lambda: click.echo("Renamed."))

    @folder.command("rm", help="Delete a folder")
    @click.argument("folder_id", metavar="id", cls=Arg)
    @click.option("--force", is_flag=True, help="don't ask")
    @click.pass_context
    def folder_rm(ctx: click.Context, folder_id: str, force: bool) -> None:
        memdot, _ = connect(ctx)
        confirm_destructive(f"Delete folder {folder_id}?", force)
        memdot.folders.delete(folder_id)
        emit(data={"id": folder_id, "deleted": True}, text=lambda: click.echo("Deleted."))

    @root.group("namespace", help="Where memories live")
    def namespace() -> None:
        pass

    @namespace.command("ls", help="List namespaces")
    @click.option("--space", metavar="id")
    @click.pass_context
    def namespace_ls(ctx: click.Context, space: str | None) -> None:
        memdot, resolved = connect(ctx)
        rows = memdot.memories.namespaces(space)
        emit(
            count=len(rows),
            data={
                "default_namespace_id": resolved.namespace_id,
                "namespaces": [
                    {
                        "id": row.id,
                        "name": row.name,
                        "mode": row.mode,
                        "space_id": row.space_id,
                        "total_memories": row.total_memories,
                        "last_write": row.last_write,
                    }
                    for row in rows
                ],
            },
            table=(
                rows,
                [
                    Column("ID", lambda r: r.id),
                    Column(
                        "Name",
                        lambda r: (
                            f"{r.name or '(sealed)'}{' *' if r.id == resolved.namespace_id else ''}"
                        ),
                        40,
                    ),
                    Column("Mode", lambda r: r.mode),
                    Column("Memories", lambda r: str(r.total_memories)),
                ],
            ),
        )

    @namespace.command("create", help="Create a namespace; its mode can't change afterwards")
    @click.argument("name", cls=Arg)
    @click.option(
        "--mode",
        metavar="mode",
        required=True,
        help="private: only devices with the key read it. assisted: the server reads text.",
    )
    @click.option("--space", metavar="id")
    @click.pass_context
    def namespace_create(ctx: click.Context, name: str, mode: str, space: str | None) -> None:
        if mode not in ("private", "assisted"):
            raise CliError("--mode is private or assisted.", EXIT["usage"], "BAD_MODE")
        memdot, _ = connect(ctx)
        created = memdot.memories.create_namespace(
            space_id=space_of(memdot, space), name=name, mode=mode
        )
        emit(data=created, text=lambda: click.echo(f"Created {created.id}"))
