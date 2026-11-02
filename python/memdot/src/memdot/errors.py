"""What can go wrong, by kind, so callers can catch what they can act on."""

from __future__ import annotations

from typing import Any


class MemDotError(Exception):
    """An error the MemDot API answered with. `code` is stable, `message` is for people."""

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        request_id: str | None = None,
        details: Any = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.request_id = request_id
        self.details = details


class AuthenticationError(MemDotError):
    """401: the key is wrong, revoked or expired, or nobody is signed in."""


class ForbiddenError(MemDotError):
    """403: this key can't do that."""


class NotFoundError(MemDotError):
    """404: it isn't there, or this key can't see it."""


class ConflictError(MemDotError):
    """409: the request is fine, but not in this state."""


class ValidationError(MemDotError):
    """400 or 422: something in the request needs changing."""


class RateLimitError(MemDotError):
    """429: too many calls, or the day's allowance is spent."""


class NetworkError(MemDotError):
    """MemDot couldn't be reached at all."""

    def __init__(self, message: str) -> None:
        super().__init__(0, "NETWORK", message)


class LockedError(Exception):
    """Raised before any request when something needs the owner's keys, which aren't here."""

    def __init__(self, what: str = "this") -> None:
        super().__init__(f"Unlock the account to do {what}: the keys stay on your device.")


class WrongKeyError(Exception):
    """A key didn't open what it was given."""

    def __init__(self, what: str | None = None) -> None:
        super().__init__(f"The key doesn't open {what or 'this'}.")


class IntegrityError(Exception):
    """The bytes a node returned don't hash to the CID they were asked for by."""

    def __init__(self, cid: str) -> None:
        super().__init__(f"bytes returned for {cid} do not match its content hash")
        self.cid = cid


class JobFailedError(Exception):
    """A storage job ended in failure."""

    def __init__(self, job: Any) -> None:
        super().__init__(f"Job {job.id} failed: {job.error or 'no reason given'}")
        self.job = job


_BY_STATUS: dict[int, type[MemDotError]] = {
    400: ValidationError,
    401: AuthenticationError,
    403: ForbiddenError,
    404: NotFoundError,
    409: ConflictError,
    422: ValidationError,
    423: ConflictError,
    429: RateLimitError,
}


def error_for(
    status: int,
    code: str,
    message: str,
    request_id: str | None = None,
    details: Any = None,
) -> MemDotError:
    return _BY_STATUS.get(status, MemDotError)(status, code, message, request_id, details)
