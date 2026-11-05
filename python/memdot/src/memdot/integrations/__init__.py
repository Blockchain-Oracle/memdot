"""MemDot in the agent frameworks. Each module needs its own extra, and says so if it's missing."""

from __future__ import annotations

import re
from collections.abc import Iterable
from typing import Any, NoReturn

from ..engine import PROMPTS


def missing(extra: str, error: ImportError) -> NoReturn:
    raise ImportError(
        f'This integration needs its framework: pip install "memdot[{extra}]"'
    ) from error


def notes(hits: Iterable[Any]) -> str:
    """Memories for a model to read, framed as notes: a memory can hold whatever someone once said."""
    lines = [
        "- " + re.sub(r"\s+", " ", hit.memory).replace("<", "&lt;").replace(">", "&gt;").strip()
        for hit in hits
    ]
    return (
        f"{PROMPTS['RECALL_PREAMBLE']}\n\n" + "\n".join(lines)
        if lines
        else "Nothing remembered about that."
    )
