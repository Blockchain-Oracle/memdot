"""The few things that differ between the two clients. `scripts/unasync.py` swaps the names."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from typing import Any, TypeVar

T = TypeVar("T")


async def asleep(seconds: float) -> None:
    await asyncio.sleep(seconds)


def sleep(seconds: float) -> None:
    time.sleep(seconds)


async def run_blocking(fn: Callable[..., T], /, *args: Any, **kwargs: Any) -> T:
    """Encryption and embedding take real CPU, so they don't run on the event loop."""
    return await asyncio.to_thread(fn, *args, **kwargs)


def run_direct(fn: Callable[..., T], /, *args: Any, **kwargs: Any) -> T:
    return fn(*args, **kwargs)
