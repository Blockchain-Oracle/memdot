"""Entities, events, jobs, agents, API keys and usage."""

from __future__ import annotations

import click

from .context import Arg, confirm_destructive, connect, parse_integer
from .output import EXIT, CliError, Column, dim, emit, say

_DEFAULT_LIMIT = 50
_ROLES = ("read_only", "read_write", "management")


def register(root: click.Group) -> None:
    @root.group("entity", help="The users, agents and runs memories are about")
    def entity() -> None:
        pass

    @entity.command("ls", help="List them, with how many memories each has")
    @click.pass_context
    def entity_ls(ctx: click.Context) -> None:
        memdot, resolved = connect(ctx)
        rows = memdot.memories.entities(namespace_id=resolved.namespace_id)
        emit(
            count=len(rows),
            data=[
                {
                    "id": row.id,
                    "type": row.type,
                    "total_memories": row.total_memories,
                    "updated_at": row.updated_at,
                }
                for row in rows
            ],
            table=(
                rows,
                [
                    Column("Type", lambda r: r.type),
                    Column("ID", lambda r: r.id, 40),
                    Column("Memories", lambda r: str(r.total_memories)),
                    Column("Updated", lambda r: (r.updated_at or "")[:10]),
                ],
            ),
        )

    @entity.command("rm", help="Forget one and all its memories")
    @click.argument("kind", metavar="type", cls=Arg, help="user, agent or run")
    @click.argument("entity_id", metavar="id", cls=Arg)
    @click.option("--dry-run", is_flag=True, help="say what would go, and change nothing")
    @click.option("--force", is_flag=True, help="don't ask")
    @click.pass_context
    def entity_rm(
        ctx: click.Context, kind: str, entity_id: str, dry_run: bool, force: bool
    ) -> None:
        if kind not in ("user", "agent", "run"):
            raise CliError("The type is user, agent or run.", EXIT["usage"], "BAD_TYPE")
        memdot, resolved = connect(ctx)
        namespace_id = resolved.namespace_id
        if dry_run:
            entities = memdot.memories.entities(namespace_id=namespace_id)
            found = next((e for e in entities if e.type == kind and e.id == entity_id), None)
            total = found.total_memories if found else 0
            emit(
                data={"dry_run": True, "would_delete": total},
                text=lambda: click.echo(f"Would forget {total} memories.\nNothing changed."),
            )
            return
        confirm_destructive(f"Forget {kind} {entity_id} and all its memories?", force)
        deleted = memdot.memories.delete_entity(kind, entity_id, namespace_id=namespace_id)
        emit(data={"deleted": deleted}, text=lambda: click.echo("Forgotten."))

    @root.group("event", help="Memory operations")
    def event() -> None:
        pass

    @event.command("ls", help="Recent writes, and whether each finished")
    @click.option(
        "--limit", metavar="n", type=parse_integer, default=_DEFAULT_LIMIT, help="how many"
    )
    @click.pass_context
    def event_ls(ctx: click.Context, limit: int) -> None:
        memdot, _ = connect(ctx)
        results = memdot.memories.events(limit=limit)["results"]
        emit(
            count=len(results),
            data=results,
            table=(
                results,
                [
                    Column("ID", lambda r: r["id"]),
                    Column("Status", lambda r: r["status"]),
                    Column("Created", lambda r: r["created_at"][:19]),
                ],
            ),
        )

    @event.command("get", help="One operation: whether it's indexed, and on the chain")
    @click.argument("event_id", metavar="id", cls=Arg)
    @click.pass_context
    def event_get(ctx: click.Context, event_id: str) -> None:
        memdot, _ = connect(ctx)
        emit(data=memdot.memories.event(event_id))

    @root.group("job", help="Storage jobs")
    def job() -> None:
        pass

    @job.command("ls", help="Recent jobs")
    @click.option("--status", metavar="status")
    @click.option(
        "--limit", metavar="n", type=parse_integer, default=_DEFAULT_LIMIT, help="how many"
    )
    @click.pass_context
    def job_ls(ctx: click.Context, status: str | None, limit: int) -> None:
        memdot, _ = connect(ctx)
        items = memdot.jobs.list(limit=limit, status=status)["items"]
        emit(
            count=len(items),
            data=items,
            table=(
                items,
                [
                    Column("ID", lambda r: r.id),
                    Column("Kind", lambda r: r.kind),
                    Column("Status", lambda r: r.status),
                    Column("Block", lambda r: "" if r.block is None else str(r.block)),
                ],
            ),
        )

    @job.command("get", help="One job")
    @click.argument("job_id", metavar="id", cls=Arg)
    @click.pass_context
    def job_get(ctx: click.Context, job_id: str) -> None:
        memdot, _ = connect(ctx)
        emit(data=memdot.jobs.get(job_id))

    @job.command("wait", help="Wait until a job finishes")
    @click.argument("job_id", metavar="id", cls=Arg)
    @click.pass_context
    def job_wait(ctx: click.Context, job_id: str) -> None:
        memdot, _ = connect(ctx)
        emit(data=memdot.jobs.wait_for(job_id, on_update=lambda u: say(dim(u.status))))

    @root.group(
        "agents", help="Connected agents; managing them takes an account-wide management key"
    )
    def agents() -> None:
        pass

    @agents.command("ls", help="List connected agents")
    @click.pass_context
    def agents_ls(ctx: click.Context) -> None:
        memdot, _ = connect(ctx)
        rows = memdot.agents.list()
        emit(
            count=len(rows),
            data=[
                {
                    "id": row.id,
                    "label": row.label,
                    "client": row.client,
                    "kind": row.kind,
                    "role": row.role,
                    "space_ids": row.space_ids,
                    "last_used_at": row.last_used_at,
                    "revoked_at": row.revoked_at,
                }
                for row in rows
            ],
            table=(
                rows,
                [
                    Column("ID", lambda r: r.id),
                    Column("Label", lambda r: r.label, 32),
                    Column("Kind", lambda r: r.kind or ""),
                    Column("Access", lambda r: r.role or ""),
                    Column("Last used", lambda r: (r.last_used_at or "never")[:19]),
                    Column("State", lambda r: "revoked" if r.revoked_at else "active"),
                ],
            ),
        )

    @agents.command("rename", help="Rename a connected agent")
    @click.argument("agent_id", metavar="id", cls=Arg)
    @click.argument("label", cls=Arg)
    @click.pass_context
    def agents_rename(ctx: click.Context, agent_id: str, label: str) -> None:
        memdot, _ = connect(ctx)
        emit(data=memdot.agents.rename(agent_id, label), text=lambda: click.echo("Renamed."))

    @agents.command(
        "revoke",
        help="Stop an agent now: its keys and tokens stop working, and its spaces change key",
    )
    @click.argument("agent_id", metavar="id", cls=Arg)
    @click.option("--force", is_flag=True, help="don't ask")
    @click.pass_context
    def agents_revoke(ctx: click.Context, agent_id: str, force: bool) -> None:
        memdot, _ = connect(ctx)
        agent = next((a for a in memdot.agents.list() if a.id == agent_id), None)
        if not agent:
            raise CliError("No such agent.", EXIT["notFound"], "NOT_FOUND")
        confirm_destructive(f"Revoke {agent.label}?", force)
        revoked = memdot.agents.revoke(agent)
        emit(data=revoked, text=lambda: click.echo(f"Revoked {agent.label}."))

    @root.group("keys", help="API keys; managing them takes an account-wide management key")
    def keys() -> None:
        pass

    @keys.command("ls", help="List API keys")
    @click.pass_context
    def keys_ls(ctx: click.Context) -> None:
        memdot, _ = connect(ctx)
        rows = memdot.keys.list()
        emit(
            count=len(rows),
            data=rows,
            table=(
                rows,
                [
                    Column("ID", lambda r: r.id),
                    Column("Name", lambda r: r.name or "", 32),
                    Column("Role", lambda r: r.role or ""),
                    Column("Starts", lambda r: r.start or ""),
                    Column("Last used", lambda r: (r.last_used_at or "never")[:19]),
                ],
            ),
        )

    def _show_new_key(created: object) -> None:
        click.echo(created.key)  # type: ignore[attr-defined]
        say(dim("Shown once: store it now."))

    @keys.command("create", help="Make a key. It's shown once, here")
    @click.argument("name", cls=Arg)
    @click.option("--role", metavar="role", default="read_write", help=", ".join(_ROLES))
    @click.option("--space", metavar="id...", multiple=True, help="limit it to these spaces")
    @click.option(
        "--expires-days", metavar="n", type=parse_integer, help="stop working after this many days"
    )
    @click.pass_context
    def keys_create(
        ctx: click.Context, name: str, role: str, space: tuple[str, ...], expires_days: int | None
    ) -> None:
        if role not in _ROLES:
            raise CliError(f"--role is one of {', '.join(_ROLES)}.", EXIT["usage"], "BAD_ROLE")
        memdot, _ = connect(ctx)
        created = memdot.keys.create(
            name, role=role, space_ids=list(space) or None, expires_in_days=expires_days
        )
        emit(
            data={"id": created.id, "name": created.name, "role": created.role, "key": created.key},
            text=lambda: _show_new_key(created),
        )

    @keys.command(
        "rotate", help="Revoke a key and make a new one with the same name, role and spaces"
    )
    @click.argument("key_id", metavar="id", cls=Arg)
    @click.option("--force", is_flag=True, help="don't ask")
    @click.pass_context
    def keys_rotate(ctx: click.Context, key_id: str, force: bool) -> None:
        memdot, _ = connect(ctx)
        confirm_destructive(f"Rotate {key_id}? The old key stops working at once.", force)
        created = memdot.keys.rotate(key_id)
        emit(
            data={"id": created.id, "name": created.name, "role": created.role, "key": created.key},
            text=lambda: _show_new_key(created),
        )

    @keys.command("revoke", help="Revoke a key")
    @click.argument("key_id", metavar="id", cls=Arg)
    @click.option("--force", is_flag=True, help="don't ask")
    @click.pass_context
    def keys_revoke(ctx: click.Context, key_id: str, force: bool) -> None:
        memdot, _ = connect(ctx)
        confirm_destructive(f"Revoke {key_id}?", force)
        memdot.keys.revoke(key_id)
        emit(data={"id": key_id, "revoked": True}, text=lambda: click.echo("Revoked."))

    @root.command("usage", help="Storage, renewals and shared-model allowance")
    @click.pass_context
    def usage(ctx: click.Context) -> None:
        memdot, _ = connect(ctx)
        emit(data=memdot.usage())

    @root.command("logs", help="Recent API requests: metadata only, never bodies")
    @click.option(
        "--limit", metavar="n", type=parse_integer, default=_DEFAULT_LIMIT, help="how many"
    )
    @click.pass_context
    def logs(ctx: click.Context, limit: int) -> None:
        memdot, _ = connect(ctx)
        items = memdot.activity.requests(limit=limit)["items"]
        emit(
            count=len(items),
            data=items,
            table=(
                items,
                [
                    Column("When", lambda r: r["createdAt"][:19]),
                    Column("Method", lambda r: r["method"]),
                    Column("Path", lambda r: r["path"], 48),
                    Column("Status", lambda r: str(r["status"])),
                    Column("ms", lambda r: str(r["latencyMs"])),
                    Column("Client", lambda r: r.get("client") or "", 24),
                ],
            ),
        )
