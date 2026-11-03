"""MemDot as a Hermes memory provider.

Hermes is Python and the plugin core is JavaScript, so this calls the same bundled core by command.
Recall, redaction, checkpoints and the Private path all stay in one place that way.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any

try:
    from agent.memory_provider import MemoryProvider, spawn_context_thread
except ImportError:  # Outside Hermes, so the file can still be imported and checked.
    import threading

    MemoryProvider = object  # type: ignore[assignment,misc]

    def spawn_context_thread(target: Any, name: str = "") -> Any:
        thread = threading.Thread(target=target, name=name, daemon=True)
        thread.start()
        return thread

_CORE = Path(__file__).parent / "core" / "memdot-plugin.mjs"
_HOST = "hermes"
_HOOK_TIMEOUT_SECONDS = 15
_TOOL_TIMEOUT_SECONDS = 60
# Only an id: from a model, anything starting with a dash could become a flag on the way down.
_MEMORY_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)

_SCOPE = {
    "type": "string",
    "enum": ["repo", "mine", "all"],
    "description": "repo: this repository, plus the user's preferences. mine: everything of the user's. all: the whole namespace.",
}

_TOOLS = [
    {
        "name": "memdot_search",
        "description": "Search what's been remembered from earlier sessions, by meaning. Use it before relearning how something works.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "What to look for."},
                "scope": _SCOPE,
                "top_k": {"type": "integer", "description": "How many results to return."},
            },
            "required": ["query"],
        },
    },
    {
        "name": "memdot_remember",
        "description": "Save one durable fact for later sessions, exactly as written. It has to make sense on its own, without this conversation.",
        "parameters": {
            "type": "object",
            "properties": {"text": {"type": "string", "description": "The fact."}},
            "required": ["text"],
        },
    },
    {
        "name": "memdot_forget",
        "description": "Permanently forget one memory. This can't be undone, so only use it after the user has clearly said to.",
        "parameters": {
            "type": "object",
            "properties": {
                "id": {"type": "string", "description": "The memory's id."},
                "confirm": {
                    "type": "boolean",
                    "description": "Set to true only after the person has said yes: this can't be undone.",
                },
            },
            "required": ["id", "confirm"],
        },
    },
    {
        "name": "memdot_status",
        "description": "Whether memory is connected and saving here, and anything stopping it.",
        "parameters": {"type": "object", "properties": {}},
    },
]


class MemDotProvider(MemoryProvider):
    def __init__(self) -> None:
        self._session = "hermes-session"
        self._cwd = os.getcwd()

    @property
    def name(self) -> str:
        return "memdot"

    def is_available(self) -> bool:
        return _CORE.exists() and shutil.which("node") is not None

    def initialize(self, session_id: str, **kwargs: Any) -> None:
        self._session = session_id or self._session
        # Hermes names the folder when a session has adopted one. Otherwise it's where it was launched,
        # which isn't always the process's own folder.
        self._cwd = kwargs.get("cwd") or os.environ.get("TERMINAL_CWD") or os.environ.get("PWD") or self._cwd
        self._hook("session-start", {"source": "startup"})

    def system_prompt_block(self) -> str:
        return ""

    def prefetch(self, query: str, *, session_id: str = "") -> str:
        return self._hook("prompt", {"prompt": query})

    def sync_turn(self, user: str, assistant: str, *, session_id: str = "", messages: Any = None) -> None:
        # Hermes asks that this never holds up the agent.
        fields = {"last_assistant_message": assistant}
        if session_id:
            fields["session_id"] = session_id
        spawn_context_thread(lambda: self._hook("stop", fields), name="memdot-sync")

    def on_pre_compress(self, messages: Any) -> str:
        self._hook("compact", {})
        return ""

    def on_session_end(self, messages: Any) -> None:
        self._hook("session-end", {})

    def get_tool_schemas(self) -> list[dict[str, Any]]:
        return _TOOLS

    def handle_tool_call(self, tool_name: str, args: dict[str, Any], **kwargs: Any) -> str:
        try:
            if tool_name == "memdot_search":
                command = ["search"]
                if args.get("scope"):
                    command += ["--scope", str(args["scope"])]
                if args.get("top_k"):
                    command += ["--top-k", str(args["top_k"])]
                return self._run(command, str(args["query"]))
            if tool_name == "memdot_remember":
                return self._run(["remember"], str(args["text"]))
            if tool_name == "memdot_forget":
                if args.get("confirm") is not True:
                    return json.dumps({"error": "Confirm with the person first, then set confirm."})
                if not _MEMORY_ID.match(str(args.get("id", ""))):
                    return json.dumps({"error": "That isn't a memory id, so nothing was forgotten."})
                return self._run(["forget", str(args["id"]), "--yes"])
            if tool_name == "memdot_status":
                return self._run(["status", "--json"])
        except (subprocess.SubprocessError, OSError, ValueError) as error:
            return json.dumps({"error": str(error)})
        return json.dumps({"error": f"Unknown tool {tool_name}"})

    def shutdown(self) -> None:
        return None

    def _hook(self, event: str, fields: dict[str, Any]) -> str:
        """One hook. Memory must never get in the way of the agent, so a failure just means nothing."""
        payload = {"session_id": self._session, "cwd": self._cwd, **fields}
        try:
            done = subprocess.run(
                ["node", str(_CORE), "hook", _HOST, event],
                input=json.dumps(payload),
                capture_output=True,
                text=True,
                timeout=_HOOK_TIMEOUT_SECONDS,
                check=False,
            )
        except (subprocess.SubprocessError, OSError):
            return ""
        return done.stdout.strip()

    def _run(self, command: list[str], text: str = "") -> str:
        done = subprocess.run(
            ["node", str(_CORE), *command],
            input=text,
            capture_output=True,
            text=True,
            cwd=self._cwd,
            timeout=_TOOL_TIMEOUT_SECONDS,
            check=False,
        )
        if done.returncode != 0:
            raise ValueError(done.stderr.strip() or "It failed.")
        return done.stdout.strip()


def register(ctx: Any) -> None:
    ctx.register_memory_provider(MemDotProvider())
