"""The memory verbs."""

from __future__ import annotations

import json
import math
import re
from pathlib import Path
from typing import Any

import click

from ..models import Memory, ScoredMemory
from .context import (
    Arg,
    confirm_destructive,
    connect,
    named_scope,
    parse_fraction,
    parse_integer,
    parse_json,
    read_stdin,
    read_text,
    scope_of,
)
from .output import EXIT, CliError, Column, dim, emit, good, say, strong

_DEFAULT_TOP_K = 10
_PAGE_SIZE = 100
_ID_WIDTH = 8


def _memory_out(memory: Memory | ScoredMemory) -> dict[str, Any]:
    out: dict[str, Any] = {"id": memory.id, "memory": memory.memory}
    if isinstance(memory, ScoredMemory):
        out["score"] = math.floor(memory.score * 1000 + 0.5) / 1000
    out.update(
        user_id=memory.user_id,
        agent_id=memory.agent_id,
        run_id=memory.run_id,
        categories=memory.categories,
        metadata=memory.metadata,
        namespace_id=memory.namespace_id,
        created_at=memory.created_at,
        expiration_date=memory.expiration_date,
    )
    return out


_COLUMNS = [
    Column("ID", lambda m: m.id),
    Column("Memory", lambda m: m.memory, 60),
    Column("User", lambda m: m.user_id or ""),
    Column("Created", lambda m: (m.created_at or "")[:10]),
]


def _print_memories(memories: list[Any]) -> None:
    if not memories:
        click.echo("Nothing found.")
        return
    for i, memory in enumerate(memories):
        click.echo(f"{i + 1}. {memory.memory}")
        score = f"Score {memory.score:.2f} · " if isinstance(memory, ScoredMemory) else ""
        who = f" · {memory.user_id}" if memory.user_id else ""
        click.echo(
            dim(f"   {score}{memory.id[:_ID_WIDTH]} · {(memory.created_at or '')[:10]}{who}")
        )


def _until_day_ends(value: str) -> str:
    if not re.match(r"^\d{4}-\d{2}-\d{2}$", value):
        raise CliError("--expires takes YYYY-MM-DD.", EXIT["usage"], "BAD_DATE")
    return value


def _filters_from(
    ctx: click.Context, raw: str | None, extra: list[dict[str, Any]] | None = None
) -> dict[str, Any] | None:
    """Combines the scope with --filter, so `-u priya --filter ...` narrows by both."""
    parts: list[dict[str, Any]] = [{k: v} for k, v in named_scope(ctx).items()]
    parts.extend(extra or [])
    if raw:
        parts.append(parse_json(raw, "--filter"))
    if not parts:
        return None
    return parts[0] if len(parts) == 1 else {"AND": parts}


def _require_namespace(resolved: Any) -> str:
    if not resolved.namespace_id:
        raise CliError("Name a namespace with --namespace.", EXIT["usage"], "NAMESPACE_REQUIRED")
    return resolved.namespace_id


def register(root: click.Group) -> None:
    @root.command("add", help="Remember something")
    @click.argument("text", required=False, cls=Arg, help="what to remember; or pipe it in")
    @click.option(
        "--messages", metavar="json", help="a conversation, as a JSON array of {role, content}"
    )
    @click.option(
        "-f", "--file", "file_path", metavar="path", help="read the conversation from a JSON file"
    )
    @click.option("-m", "--metadata", metavar="json", help="metadata to keep with it")
    @click.option("--no-infer", is_flag=True, help="store it exactly as written, without a model")
    @click.option("--procedural", is_flag=True, help="keep this as an agent's working record")
    @click.option("--immutable", is_flag=True, help="never let it change")
    @click.option("--expires", metavar="date", help="when it stops counting (YYYY-MM-DD)")
    @click.option("--timestamp", metavar="time", help="when it happened (ISO time or unix seconds)")
    @click.option("--prompt", metavar="text", help="custom instructions, for this call only")
    @click.option(
        "--categories",
        metavar="json",
        help="categories to file under, as a JSON array of {name, description}",
    )
    @click.option("--wait-chain", is_flag=True, help="wait until it's finalized on Portaldot V3")
    @click.option("--no-wait", is_flag=True, help="return at once with an event to follow")
    @click.pass_context
    def add(ctx: click.Context, text: str | None, **options: Any) -> None:
        memdot, resolved = connect(ctx)
        if options["file_path"]:
            content: Any = parse_json(read_text(options["file_path"]), "--file")
        elif options["messages"]:
            content = parse_json(options["messages"], "--messages")
        else:
            content = text or read_stdin() or ""
        if not content:
            raise CliError("Say what to remember, or pipe it in.", EXIT["usage"], "EMPTY")
        scope = scope_of(ctx, resolved)
        kwargs: dict[str, Any] = {}
        if options["expires"]:
            kwargs["expiration_date"] = _until_day_ends(options["expires"])
        timestamp = options["timestamp"]
        if timestamp:
            kwargs["timestamp"] = int(timestamp) if timestamp.isdigit() else timestamp
        added = memdot.memories.add(
            content,
            namespace_id=resolved.namespace_id,
            metadata=parse_json(options["metadata"], "--metadata") if options["metadata"] else None,
            infer=not options["no_infer"],
            memory_type="procedural_memory" if options["procedural"] else None,
            immutable=options["immutable"],
            prompt=options["prompt"],
            categories=(
                parse_json(options["categories"], "--categories") if options["categories"] else None
            ),
            wait=False if options["no_wait"] else ("chain" if options["wait_chain"] else "indexed"),
            **scope,
            **kwargs,
        )

        def show() -> None:
            if not added.results and added.event_id:
                click.echo(f"Queued. Follow it with: memdot event get {added.event_id}")
            elif not added.results:
                click.echo("Nothing new: that's already remembered.")
            for result in added.results:
                click.echo(f"{good('+')} {result.memory}  {dim(result.id[:_ID_WIDTH])}")
            if added.duplicates:
                click.echo(dim(f"{added.duplicates} already remembered"))
            if added.note:
                click.echo(dim(added.note))

        emit(
            count=len(added.results),
            scope=scope,
            data={
                "event_id": added.event_id,
                "status": added.status,
                "namespace_id": added.namespace_id,
                "results": [
                    {"id": r.id, "memory": r.memory, "event": r.event} for r in added.results
                ],
                "duplicates": added.duplicates,
                "note": added.note,
            },
            text=show,
        )

    @root.command("search", help="Find what's been remembered, by meaning and keyword")
    @click.argument("query", required=False, cls=Arg, help="what to look for; or pipe it in")
    @click.option(
        "-k",
        "--top-k",
        metavar="n",
        type=parse_integer,
        default=_DEFAULT_TOP_K,
        help="how many results",
    )
    @click.option(
        "--threshold", metavar="n", type=parse_fraction, help="minimum similarity, 0 to 1"
    )
    @click.option("--keyword", is_flag=True, help="match words only")
    @click.option("--semantic", is_flag=True, help="match meaning only")
    @click.option("--rerank", is_flag=True, help="let the model put the best first")
    @click.option(
        "--filter", "filter_json", metavar="json", help='for example {"AND":[{"user_id":"priya"}]}'
    )
    @click.option("--show-expired", is_flag=True, help="include what has expired")
    @click.option("--reference-date", metavar="date", help="search as of this moment")
    @click.option("--fields", metavar="list", help="only these fields, comma separated")
    @click.pass_context
    def search(ctx: click.Context, query: str | None, **options: Any) -> None:
        memdot, resolved = connect(ctx)
        text = query or read_stdin()
        if not text:
            raise CliError("Say what to search for.", EXIT["usage"], "EMPTY")
        kwargs: dict[str, Any] = {}
        if options["threshold"] is not None:
            kwargs["threshold"] = options["threshold"]
        if options["keyword"]:
            kwargs["mode"] = "keyword"
        if options["semantic"]:
            kwargs["mode"] = "semantic"
        results = memdot.memories.search(
            text,
            top_k=options["top_k"],
            namespace_id=resolved.namespace_id,
            filters=_filters_from(ctx, options["filter_json"]),
            rerank=options["rerank"],
            show_expired=options["show_expired"],
            reference_date=options["reference_date"],
            **kwargs,
        )
        fields = options["fields"].split(",") if options["fields"] else None

        def shaped(memory: ScoredMemory) -> dict[str, Any]:
            out = _memory_out(memory)
            return {k: v for k, v in out.items() if k in fields} if fields else out

        emit(
            count=len(results),
            scope=named_scope(ctx),
            data=[shaped(memory) for memory in results],
            text=lambda: _print_memories(results),
            table=(
                results,
                [_COLUMNS[0], Column("Score", lambda m: f"{m.score:.2f}"), *_COLUMNS[1:]],
            ),
        )

    @root.command("list", help="List memories, newest first")
    @click.option(
        "--page-size",
        metavar="n",
        type=parse_integer,
        default=_PAGE_SIZE,
        help="how many at a time",
    )
    @click.option("--cursor", metavar="cursor", help="next_cursor from the page before")
    @click.option("--category", metavar="name", help="only this category")
    @click.option("--after", metavar="date", help="created after this date")
    @click.option("--before", metavar="date", help="created before this date")
    @click.option("--filter", "filter_json", metavar="json", help='for example {"user_id":"priya"}')
    @click.option("--show-expired", is_flag=True, help="include what has expired")
    @click.pass_context
    def list_memories(ctx: click.Context, **options: Any) -> None:
        memdot, resolved = connect(ctx)
        extra = []
        if options["category"]:
            extra.append({"categories": {"in": [options["category"]]}})
        if options["after"]:
            extra.append({"created_at": {"gte": options["after"]}})
        if options["before"]:
            extra.append({"created_at": {"lte": options["before"]}})
        page = memdot.memories.list(
            page_size=options["page_size"],
            namespace_id=resolved.namespace_id,
            filters=_filters_from(ctx, options["filter_json"], extra),
            cursor=options["cursor"],
            show_expired=options["show_expired"],
        )
        emit(
            count=len(page.results),
            scope=named_scope(ctx),
            data={
                "results": [_memory_out(memory) for memory in page.results],
                "next_cursor": page.next_cursor,
            },
            table=(page.results, _COLUMNS),
        )

    @root.command("get", help="Read one memory")
    @click.argument("memory_id", metavar="id", cls=Arg)
    @click.pass_context
    def get(ctx: click.Context, memory_id: str) -> None:
        memdot, _ = connect(ctx)
        memory = memdot.memories.get(memory_id)

        def show() -> None:
            click.echo(strong(memory.memory))
            click.echo(dim(f"{memory.id} · v{memory.version} · {memory.created_at}"))
            if memory.segment and memory.segment.get("cid"):
                click.echo(dim(f"On Portaldot V3: {memory.segment['cid']}"))

        emit(
            data={
                **_memory_out(memory),
                "version": memory.version,
                "updated_at": memory.updated_at,
                "segment": memory.segment,
                "source": memory.source.to_dict() if memory.source else None,
            },
            text=show,
        )

    @root.command("update", help="Correct a memory; the old version stays in its history")
    @click.argument("memory_id", metavar="id", cls=Arg)
    @click.argument("text", required=False, cls=Arg, help="what it should say; or pipe it in")
    @click.option("-m", "--metadata", metavar="json", help="metadata to merge in")
    @click.option("--expires", metavar="date", help="when it stops counting (YYYY-MM-DD)")
    @click.pass_context
    def update(ctx: click.Context, memory_id: str, text: str | None, **options: Any) -> None:
        memdot, _ = connect(ctx)
        body = text or read_stdin()
        if not body and not options["metadata"] and not options["expires"]:
            raise CliError("Say what should change.", EXIT["usage"], "EMPTY")
        kwargs: dict[str, Any] = {}
        if options["expires"]:
            kwargs["expiration_date"] = _until_day_ends(options["expires"])
        memory = memdot.memories.update(
            memory_id,
            text=body,
            metadata=parse_json(options["metadata"], "--metadata") if options["metadata"] else None,
            **kwargs,
        )
        emit(data=_memory_out(memory), text=lambda: click.echo(f"{good('~')} {memory.memory}"))

    @root.command("delete", help="Forget a memory, or everything in a scope")
    @click.argument("memory_id", metavar="id", required=False, cls=Arg)
    @click.option(
        "--all",
        "all_",
        is_flag=True,
        help="everything in the given scope (-u, --agent-id or --run-id)",
    )
    @click.option("--dry-run", is_flag=True, help="say what would go, and change nothing")
    @click.option("--force", is_flag=True, help="don't ask")
    @click.pass_context
    def delete(
        ctx: click.Context, memory_id: str | None, all_: bool, dry_run: bool, force: bool
    ) -> None:
        if bool(memory_id) == bool(all_):
            raise CliError("Give a memory id, or --all with a scope.", EXIT["usage"], "BAD_ARGS")
        memdot, resolved = connect(ctx)
        if memory_id:
            memory = memdot.memories.get(memory_id)
            if dry_run:
                emit(
                    count=1,
                    data={"dry_run": True, "would_delete": 1, "memories": [_memory_out(memory)]},
                    text=lambda: click.echo(f"Would forget: {memory.memory}\nNothing changed."),
                )
                return
            confirm_destructive(f'Forget "{memory.memory}"?', force)
            memdot.memories.delete(memory_id)
            emit(
                count=1,
                data={"id": memory_id, "deleted": True},
                text=lambda: click.echo(f"Forgotten: {memory.memory}"),
            )
            return

        scope = named_scope(ctx)
        if not scope:
            raise CliError(
                "Name a scope with -u, --agent-id or --run-id: this won't forget a whole namespace.",
                EXIT["usage"],
                "SCOPE_REQUIRED",
            )
        if dry_run:
            total = 0
            cursor = None
            filters = _filters_from(ctx, None)
            while True:
                page = memdot.memories.list(
                    namespace_id=resolved.namespace_id,
                    page_size=_PAGE_SIZE,
                    filters=filters,
                    cursor=cursor,
                )
                total += len(page.results)
                cursor = page.next_cursor
                if not cursor:
                    break
            emit(
                count=total,
                scope=scope,
                data={"dry_run": True, "would_delete": total},
                text=lambda: click.echo(f"Would forget {total} memories.\nNothing changed."),
            )
            return
        confirm_destructive(f"Forget everything for {json.dumps(scope)}?", force)
        deleted = memdot.memories.delete_all(namespace_id=resolved.namespace_id, **scope)
        emit(
            count=deleted,
            scope=scope,
            data={"deleted": deleted},
            text=lambda: click.echo(f"Forgot {deleted} memories."),
        )

    @root.command("history", help="How a memory changed")
    @click.argument("memory_id", metavar="id", cls=Arg)
    @click.pass_context
    def history(ctx: click.Context, memory_id: str) -> None:
        memdot, _ = connect(ctx)
        events = memdot.memories.history(memory_id)
        emit(
            count=len(events),
            data=[
                {
                    "event": event.event,
                    "old_memory": event.old_memory,
                    "new_memory": event.new_memory,
                    "actor": event.actor,
                    "created_at": event.created_at,
                }
                for event in events
            ],
            table=(
                events,
                [
                    Column("When", lambda e: (e.created_at or "")[:19]),
                    Column("Event", lambda e: e.event),
                    Column("Memory", lambda e: e.new_memory or e.old_memory or "", 70),
                ],
            ),
        )

    @root.command("import", help="Bring memories in from a MemDot or Mem0 export")
    @click.argument("file", cls=Arg, help="a JSON file")
    @click.option("--source", metavar="name", default="cli", help="where these came from")
    @click.pass_context
    def import_memories(ctx: click.Context, file: str, source: str) -> None:
        memdot, resolved = connect(ctx)
        namespace_id = _require_namespace(resolved)
        items = parse_json(read_text(file), "That file")
        say(dim("Importing…"))
        report = memdot.memories.import_memories(items, source=source, namespace_id=namespace_id)
        emit(
            count=report["imported"],
            data={**report, "namespace_id": namespace_id},
            text=lambda: click.echo(
                f"Imported {report['imported']}. {report['duplicates']} were already here."
            ),
        )

    @root.command("export", help="Write a namespace's memories out as JSON, decrypted here")
    @click.option("--out", metavar="file", help="where to write it (default: stdout)")
    @click.pass_context
    def export_memories(ctx: click.Context, out: str | None) -> None:
        memdot, resolved = connect(ctx)
        memories = memdot.memories.export_memories(_require_namespace(resolved))
        rendered = json.dumps(memories, indent=2, ensure_ascii=False)
        if out:
            Path(out).write_text(f"{rendered}\n", "utf8")

        def show() -> None:
            click.echo(f"Wrote {len(memories)} memories to {out}." if out else rendered)

        emit(
            count=len(memories),
            data={"exported": len(memories), "out": out} if out else memories,
            text=show,
        )

    @root.command("restore", help="Rebuild a namespace's search from the chain")
    @click.pass_context
    def restore(ctx: click.Context) -> None:
        memdot, resolved = connect(ctx)
        namespace_id = _require_namespace(resolved)
        say(dim("Reading it back from Portaldot V3…"))
        emit(data=memdot.memories.restore(namespace_id))
