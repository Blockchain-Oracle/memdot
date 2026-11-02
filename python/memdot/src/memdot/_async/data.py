"""Taking your data with you.

Everything is decrypted on this device: an export holds plaintext, so it should be kept as carefully
as the data itself.
"""

from __future__ import annotations

import io
import json
import re
import zipfile
from collections.abc import Callable
from typing import Any

from ..engine import iso_now
from ..errors import MemDotError, ValidationError
from ..models import ArchiveExport, ExportFailure, FileInfo, ImportReport
from .context import AsyncContext
from .files import AsyncFiles
from .memories import AsyncMemories
from .spaces import AsyncFolders, AsyncSpaces

_MANIFEST = "manifest.json"
_LIST_PAGE = 200
_RECOVERABLE = (MemDotError, ValueError)


def _safe_name(name: str) -> str:
    """Zip entries can't climb out of the archive."""
    return re.sub(r"^\.+", "_", re.sub(r"[/\\]", "_", name)) or "file"


class AsyncData:
    def __init__(
        self,
        ctx: AsyncContext,
        spaces: AsyncSpaces,
        folders: AsyncFolders,
        files: AsyncFiles,
        memories: AsyncMemories,
    ) -> None:
        self._ctx = ctx
        self._spaces = spaces
        self._folders = folders
        self._files = files
        self._memories = memories

    async def _all_files(self, space_id: str) -> list[FileInfo]:
        items: list[FileInfo] = []
        cursor = None
        while True:
            page = await self._files.list(space_id=space_id, limit=_LIST_PAGE, cursor=cursor)
            items.extend(page.items)
            cursor = page.next_cursor
            if not cursor:
                return items

    async def export_archive(
        self, *, on_progress: Callable[[dict[str, Any]], None] | None = None
    ) -> ArchiveExport:
        """Reads every space, file and memory this device can open, into one zip."""
        failures: list[ExportFailure] = []
        archive: dict[str, bytes] = {}
        manifest: dict[str, Any] = {
            "format": "memdot-export",
            "version": 1,
            "exportedAt": iso_now(),
            "spaces": [],
        }
        listed = []
        for space in await self._spaces.list():
            listed.append(
                (
                    space,
                    await self._folders.list(space.id),
                    await self._all_files(space.id),
                    await self._memories.namespaces(space.id),
                )
            )
        total = sum(len(files) + len(namespaces) for _, _, files, namespaces in listed)
        done = 0

        def report(step: str) -> None:
            if on_progress:
                on_progress({"step": step, "done": done, "total": total})

        for space, folders, files, namespaces in listed:
            entry: dict[str, Any] = {
                "id": space.id,
                "name": space.name or space.id,
                "mode": space.mode,
                "folders": [
                    {
                        "id": folder.id,
                        "name": folder.name or folder.id,
                        "parentId": folder.parent_id,
                    }
                    for folder in folders
                    if folder.memory_mode == "off"
                ],
                "files": [],
                "namespaces": [],
            }
            used: set[str] = set()
            for file in files:
                if file.status != "stored":
                    continue
                label = file.name or file.id
                report(label)
                try:
                    opened = await self._files.get(file.id)
                    path = f"files/{_safe_name(entry['name'])}/{_safe_name(opened.name)}"
                    if path in used:
                        path = (
                            f"files/{_safe_name(entry['name'])}/{file.id}-{_safe_name(opened.name)}"
                        )
                    used.add(path)
                    archive[path] = opened.data
                    entry["files"].append(
                        {
                            "path": path,
                            "name": opened.name,
                            "mime": opened.mime,
                            "size": len(opened.data),
                            "folderId": file.folder_id,
                        }
                    )
                except _RECOVERABLE as error:
                    failures.append(ExportFailure(item=label, reason=str(error)))
                done += 1
            for namespace in namespaces:
                label = namespace.name or namespace.id
                report(label)
                try:
                    entry["namespaces"].append(
                        {
                            "id": namespace.id,
                            "name": label,
                            "mode": namespace.mode,
                            "memories": await self._memories.export_memories(namespace.id),
                        }
                    )
                except _RECOVERABLE as error:
                    failures.append(ExportFailure(item=label, reason=str(error)))
                done += 1
            manifest["spaces"].append(entry)

        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as bundle:
            for path, data in archive.items():
                bundle.writestr(path, data)
            bundle.writestr(_MANIFEST, json.dumps(manifest, indent=2, ensure_ascii=False))
        return ArchiveExport(zip=buffer.getvalue(), manifest=manifest, failures=failures)

    async def import_archive(
        self,
        archive: bytes,
        *,
        space_id: str | None = None,
        on_progress: Callable[[dict[str, Any]], None] | None = None,
    ) -> ImportReport:
        """Brings an export back: into new spaces with the same names, or one you name.

        Sponsored spaces hold little, so a big export may need a wallet-paid space; what doesn't fit
        is reported.
        """
        try:
            bundle = zipfile.ZipFile(io.BytesIO(archive))
            manifest = json.loads(bundle.read(_MANIFEST))
        except (zipfile.BadZipFile, KeyError, ValueError) as error:
            raise ValidationError(
                400, "NOT_AN_EXPORT", "That zip isn't a MemDot export."
            ) from error
        if manifest.get("format") != "memdot-export" or manifest.get("version") != 1:
            raise ValidationError(
                400, "NOT_AN_EXPORT", "That zip isn't a MemDot export this version can read."
            )
        report = ImportReport()
        total = sum(len(s["files"]) + len(s["namespaces"]) for s in manifest["spaces"])
        done = 0

        def step(label: str) -> None:
            if on_progress:
                on_progress({"step": label, "done": done, "total": total})

        for exported in manifest["spaces"]:
            target = space_id
            if not target:
                try:
                    target = (await self._spaces.create(exported["name"])).id
                    report.spaces += 1
                except _RECOVERABLE as error:
                    report.failures.append(ExportFailure(item=exported["name"], reason=str(error)))
                    continue
            folder_ids: dict[str, str] = {}
            # Parents come before children, in as many passes as the tree is deep.
            pending = list(exported["folders"])
            while pending:
                ready = [f for f in pending if not f["parentId"] or f["parentId"] in folder_ids]
                if not ready:
                    break
                for folder in ready:
                    created = await self._folders.create(
                        target, folder["name"], parent_id=folder_ids.get(folder["parentId"])
                    )
                    folder_ids[folder["id"]] = created.id
                    report.folders += 1
                pending = [f for f in pending if f not in ready]
            for file in exported["files"]:
                step(file["name"])
                try:
                    data = bundle.read(file["path"])
                    await self._files.put(
                        data,
                        space_id=target,
                        name=file["name"],
                        mime=file["mime"],
                        wait=False,
                        folder_id=folder_ids.get(file.get("folderId")),
                    )
                    report.files += 1
                except KeyError:
                    report.failures.append(
                        ExportFailure(item=file["name"], reason="Missing from the zip.")
                    )
                except _RECOVERABLE as error:
                    report.failures.append(ExportFailure(item=file["name"], reason=str(error)))
                done += 1
            for namespace in exported["namespaces"]:
                step(namespace["name"])
                try:
                    created_namespace = await self._memories.create_namespace(
                        space_id=target, name=namespace["name"], mode=namespace["mode"]
                    )
                    if namespace["memories"]:
                        result = await self._memories.import_memories(
                            namespace["memories"],
                            namespace_id=created_namespace.id,
                            source="memdot-export",
                            user_id="imported",
                        )
                        report.memories += result["imported"]
                        report.duplicates += result["duplicates"]
                except _RECOVERABLE as error:
                    report.failures.append(ExportFailure(item=namespace["name"], reason=str(error)))
                done += 1
        return report

    async def delete_account(self) -> None:
        """Stops every renewal, forgets all memories, revokes keys, agents and grants.

        Stored bytes expire from the chain within 7 days. Export first if you want a copy; nothing
        brings it back. Dashboard sessions only.
        """
        record = self._ctx.registry.delete_account_calldata()
        await self._ctx.transport.json(
            "DELETE", "/v1/account", {"record": record} if record else {}
        )
        self._ctx.vault.lock()
