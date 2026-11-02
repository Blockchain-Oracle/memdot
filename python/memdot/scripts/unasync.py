"""Writes the sync client from the async one, so the two can't drift.

uv run python scripts/unasync.py          # regenerate src/memdot/_sync
uv run python scripts/unasync.py --check  # fail if it's out of date (CI)
"""

from __future__ import annotations

import io
import subprocess
import sys
import tokenize
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "src" / "memdot" / "_async"
TARGET = ROOT / "src" / "memdot" / "_sync"
HEADER = "# Generated from ../_async by scripts/unasync.py. Edit that, not this.\n"
RENAMES = {
    "__aenter__": "__enter__",
    "__aexit__": "__exit__",
    "aclose": "close",
    "asleep": "sleep",
    "run_blocking": "run_direct",
}


def renamed(name: str) -> str:
    if name in RENAMES:
        return RENAMES[name]
    return name[len("Async") :] if name.startswith("Async") else name


def strip_awaitable(text: str) -> str:
    """`Awaitable[x]` is `x` when nothing is awaited; `x` may hold brackets of its own."""
    marker = "Awaitable["
    while marker in text:
        start = text.index(marker)
        depth = 1
        end = start + len(marker)
        while depth:
            depth += {"[": 1, "]": -1}.get(text[end], 0)
            end += 1
        text = text[:start] + text[start + len(marker) : end - 1] + text[end:]
    return text


def convert(source: str) -> str:
    lines = source.splitlines(keepends=True)
    edits: list[tuple[int, int, int, str]] = []
    for token in tokenize.generate_tokens(io.StringIO(source).readline):
        if token.type != tokenize.NAME:
            continue
        row, col = token.start
        end = token.end[1]
        if token.string in ("await", "async"):
            # The space after it goes too.
            edits.append((row, col, end + 1, ""))
        elif (new := renamed(token.string)) != token.string:
            edits.append((row, col, end, new))
    for row, col, end, new in reversed(edits):
        line = lines[row - 1]
        lines[row - 1] = line[:col] + new + line[end:]
    return strip_awaitable("".join(lines))


def tidy(text: str, name: str) -> str:
    """Unused imports out, imports in order, and lines formatted, as ruff would have them."""
    fixed = subprocess.run(
        ["ruff", "check", "--fix-only", "--select", "F401,I", "--stdin-filename", name, "-"],
        input=text,
        capture_output=True,
        text=True,
        check=True,
        cwd=ROOT,
    ).stdout
    return subprocess.run(
        ["ruff", "format", "--stdin-filename", name, "-"],
        input=fixed,
        capture_output=True,
        text=True,
        check=True,
        cwd=ROOT,
    ).stdout


def generated() -> dict[str, str]:
    files = {}
    for path in sorted(SOURCE.glob("*.py")):
        text = path.read_text("utf8")
        if text.strip():
            text = tidy(HEADER + convert(text), f"src/memdot/_sync/{path.name}")
        files[path.name] = text
    return files


def main() -> int:
    files = generated()
    if "--check" in sys.argv:
        stale = [
            name
            for name, text in files.items()
            if not (TARGET / name).exists() or (TARGET / name).read_text("utf8") != text
        ]
        if stale:
            print(f"Out of date, run scripts/unasync.py: {', '.join(stale)}", file=sys.stderr)
            return 1
        return 0
    TARGET.mkdir(exist_ok=True)
    for name, text in files.items():
        (TARGET / name).write_text(text, "utf8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
