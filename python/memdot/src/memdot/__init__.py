"""MemDot for Python: encrypted storage and agent memory on Portaldot V3.

from memdot import MemDot

memdot = MemDot.from_credentials()
memdot.add("Priya prefers tea", user_id="priya")
memdot.search("what does Priya drink?", user_id="priya")
"""

from ._async.client import AsyncMemDot
from ._constants import __version__
from ._sync.client import MemDot
from .errors import (
    AuthenticationError,
    ConflictError,
    ForbiddenError,
    IntegrityError,
    JobFailedError,
    LockedError,
    MemDotError,
    NetworkError,
    NotFoundError,
    RateLimitError,
    ValidationError,
    WrongKeyError,
)
from .models import (
    AddResult,
    Agent,
    ApiKey,
    Entity,
    FileData,
    FileInfo,
    FilePage,
    Folder,
    Grant,
    HistoryEvent,
    Job,
    Memory,
    MemoryEvent,
    MemoryPage,
    Namespace,
    PutResult,
    ScoredMemory,
    Space,
    Usage,
    VerifyResult,
)
from .wallet import Wallet

__all__ = [
    "AddResult",
    "Agent",
    "ApiKey",
    "AsyncMemDot",
    "AuthenticationError",
    "ConflictError",
    "Entity",
    "FileData",
    "FileInfo",
    "FilePage",
    "Folder",
    "ForbiddenError",
    "Grant",
    "HistoryEvent",
    "IntegrityError",
    "Job",
    "JobFailedError",
    "LockedError",
    "MemDot",
    "MemDotError",
    "Memory",
    "MemoryEvent",
    "MemoryPage",
    "Namespace",
    "NetworkError",
    "NotFoundError",
    "PutResult",
    "RateLimitError",
    "ScoredMemory",
    "Space",
    "Usage",
    "ValidationError",
    "VerifyResult",
    "Wallet",
    "WrongKeyError",
    "__version__",
]
