"""The parts that only pass requests along: jobs, API keys, activity and public proof."""

from __future__ import annotations

import json as jsonlib
import time
from collections.abc import Callable
from typing import Any

from .._concurrency import asleep
from ..errors import JobFailedError, MemDotError
from ..models import ApiKey, Job, NewApiKey
from .context import AsyncContext

_TERMINAL = {"finalized", "failed"}
_POLL_SECONDS = 2.0
_DEFAULT_TIMEOUT_SECONDS = 300.0


class AsyncJobs:
    """Every write is a job: queued, encrypting, submitted, in block, finalized."""

    def __init__(self, ctx: AsyncContext) -> None:
        self._ctx = ctx

    async def get(self, job_id: str) -> Job:
        return Job.model_validate(await self._ctx.transport.json("GET", f"/v1/jobs/{job_id}"))

    async def list(
        self,
        *,
        status: str | None = None,
        kind: str | None = None,
        cursor: str | None = None,
        limit: int | None = None,
    ) -> dict[str, Any]:
        page = await self._ctx.transport.json(
            "GET",
            "/v1/jobs",
            params={"status": status, "kind": kind, "cursor": cursor, "limit": limit},
        )
        return {**page, "items": [Job.model_validate(item) for item in page["items"]]}

    async def wait_for(
        self,
        job_id: str,
        *,
        timeout: float = _DEFAULT_TIMEOUT_SECONDS,
        on_update: Callable[[Job], None] | None = None,
        raise_on_failure: bool = True,
    ) -> Job:
        """Follows a job to its end. `on_update` hears each change, once."""
        deadline = time.monotonic() + timeout
        last = ""

        def report(job: Job) -> None:
            nonlocal last
            progress = job.progress or {}
            key = f"{job.status}:{progress.get('done', '')}/{progress.get('total', '')}"
            if key != last:
                last = key
                if on_update:
                    on_update(job)

        while True:
            job = await self.get(job_id)
            report(job)
            if job.status in _TERMINAL:
                if job.status == "failed" and raise_on_failure:
                    raise JobFailedError(job)
                return job
            if time.monotonic() > deadline:
                raise MemDotError(408, "JOB_TIMEOUT", f"Job {job_id} is still {job.status}.")
            await asleep(_POLL_SECONDS)

    async def events(self, job_id: str) -> list[dict[str, Any]]:
        """What the job's stream holds now, for tools that want the raw updates."""
        response = await self._ctx.transport.send(
            "GET", f"/v1/jobs/{job_id}/events", headers={"accept": "text/event-stream"}
        )
        return [
            jsonlib.loads(line[len("data: ") :])
            for line in response.text.splitlines()
            if line.startswith("data: ")
        ]


class AsyncKeys:
    """API keys. The full key is returned once; MemDot keeps only a hash."""

    def __init__(self, ctx: AsyncContext) -> None:
        self._ctx = ctx

    async def list(self) -> list[ApiKey]:
        page = await self._ctx.transport.json("GET", "/v1/keys")
        return [ApiKey.model_validate(item) for item in page["items"]]

    async def create(
        self,
        name: str,
        *,
        role: str = "read_write",
        space_ids: list[str] | None = None,
        agent_id: str | None = None,
        expires_in_days: int | None = None,
    ) -> NewApiKey:
        body: dict[str, Any] = {"name": name, "role": role, "spaceIds": space_ids}
        if agent_id:
            body["agentId"] = agent_id
        if expires_in_days:
            body["expiresInDays"] = expires_in_days
        return NewApiKey.model_validate(await self._ctx.transport.json("POST", "/v1/keys", body))

    async def rotate(self, key_id: str) -> NewApiKey:
        """Revokes the key first, then mints a new one with the same name, role and spaces."""
        answer = await self._ctx.transport.json("POST", f"/v1/keys/{key_id}/rotate")
        return NewApiKey.model_validate(answer)

    async def revoke(self, key_id: str) -> Any:
        return await self._ctx.transport.json("DELETE", f"/v1/keys/{key_id}")


class AsyncActivity:
    """What happened on your account: API requests (metadata only) and chain transactions."""

    def __init__(self, ctx: AsyncContext) -> None:
        self._ctx = ctx

    async def requests(self, *, cursor: str | None = None, limit: int | None = None) -> Any:
        """Method, path, status, latency, key prefix and client; never bodies. Newest first."""
        return await self._ctx.transport.json(
            "GET", "/v1/activity/requests", params={"cursor": cursor, "limit": limit}
        )

    async def transactions(self, *, cursor: str | None = None, limit: int | None = None) -> Any:
        """Every store and renewal on Portaldot V3 for your data, newest first."""
        return await self._ctx.transport.json(
            "GET", "/v1/activity/transactions", params={"cursor": cursor, "limit": limit}
        )


class AsyncProof:
    """Public proof: no account needed, and the bytes stay encrypted."""

    def __init__(self, ctx: AsyncContext) -> None:
        self._ctx = ctx

    async def cid(self, cid: str) -> Any:
        return await self._ctx.transport.json("GET", f"/v1/proof/cid/{cid}")

    async def tx(self, tx_hash: str) -> Any:
        return await self._ctx.transport.json("GET", f"/v1/proof/tx/{tx_hash}")

    async def stats(self) -> Any:
        return await self._ctx.transport.json("GET", "/v1/proof/stats")

    async def recent(self) -> Any:
        return await self._ctx.transport.json("GET", "/v1/proof/recent")
