"""MemDot in the agent frameworks. Each module needs its own extra, and says so if it's missing."""

from __future__ import annotations

from typing import NoReturn


def missing(extra: str, error: ImportError) -> NoReturn:
    raise ImportError(
        f'This integration needs its framework: pip install "memdot[{extra}]"'
    ) from error
