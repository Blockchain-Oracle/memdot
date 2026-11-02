"""One connection to the API."""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

import httpx

from .._constants import __version__
from ..chain import check_blob
from ..errors import MemDotError, NetworkError, error_for

SDK_CLIENT = f"sdk-py/{__version__}"
_TIMEOUT = httpx.Timeout(60.0, connect=20.0)


def seg(value: object) -> str:
    """One path segment, whatever it holds: `priya#work` must not become `priya`, nor `../x` climb."""
    return quote(str(value), safe="")


class AsyncTransport:
    """The API key, or the session cookie kept here, on every request."""

    def __init__(
        self,
        base_url: str,
        api_key: str | None = None,
        origin: str | None = None,
        client: str | None = None,
        http: httpx.AsyncClient | None = None,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.origin = origin
        self.client_name = client or SDK_CLIENT
        self._http = http or httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=False)

    def _headers(self, extra: dict[str, str] | None) -> dict[str, str]:
        headers = {"x-memdot-client": self.client_name, **(extra or {})}
        if self.api_key:
            headers["authorization"] = f"Bearer {self.api_key}"
        elif self.origin:
            headers["origin"] = self.origin
        return headers

    async def send(
        self,
        method: str,
        path: str,
        *,
        json: Any = None,
        body: bytes | None = None,
        params: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> httpx.Response:
        query = {k: _query_value(v) for k, v in (params or {}).items() if v is not None}
        try:
            response = await self._http.request(
                method,
                f"{self.base_url}{path}",
                json=json,
                content=body,
                params=query or None,
                headers=self._headers(headers),
            )
        except httpx.TransportError as error:
            raise NetworkError(f"Couldn't reach {self.base_url}: {error}") from error
        if response.is_error:
            raise _error_from(response)
        return response

    async def json(
        self,
        method: str,
        path: str,
        body: Any = None,
        *,
        params: dict[str, Any] | None = None,
        headers: dict[str, str] | None = None,
    ) -> Any:
        response = await self.send(method, path, json=body, params=params, headers=headers)
        return response.json() if response.content else None

    async def bytes(self, path: str) -> bytes:
        return (await self.send("GET", path)).content

    async def blob(self, cid: str) -> bytes:
        """Stored bytes through MemDot's gateway, checked against their CID here."""
        return check_blob(cid, await self.bytes(f"/v1/cids/{seg(cid)}"))

    async def aclose(self) -> None:
        await self._http.aclose()


def _query_value(value: Any) -> Any:
    return ("true" if value else "false") if isinstance(value, bool) else value


def _error_from(response: httpx.Response) -> MemDotError:
    try:
        error = response.json().get("error") or {}
    except ValueError:
        # Not JSON (a proxy error page, say); the status still tells the story.
        error = {}
    return error_for(
        response.status_code,
        error.get("code") or f"HTTP_{response.status_code}",
        error.get("message") or response.reason_phrase,
        error.get("requestId") or response.headers.get("x-request-id"),
        error.get("details"),
    )
