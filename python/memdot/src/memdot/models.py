"""What the client returns. Fields are snake_case here and keep the wire's spelling in JSON."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class Model(BaseModel):
    """Answers `hit["memory"]` as well as `hit.memory`, and keeps fields it doesn't know yet."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="allow")

    def __getitem__(self, name: str) -> Any:
        try:
            return getattr(self, name)
        except AttributeError as error:
            raise KeyError(name) from error

    def get(self, name: str, default: Any = None) -> Any:
        return getattr(self, name, default)

    def to_dict(self) -> dict[str, Any]:
        """As JSON would have it: the same names the TypeScript SDK and the Node CLI use."""
        return self.model_dump(by_alias=True, mode="json")


class WireModel(Model):
    """For routes whose JSON is already snake_case."""

    model_config = ConfigDict(populate_by_name=True, extra="allow")


class Job(Model):
    id: str
    account_id: str | None = None
    kind: str
    status: str
    tx_hash: str | None = None
    block: int | None = None
    error: str | None = None
    progress: dict[str, Any] | None = None
    updated_at: str | None = None


class Space(Model):
    id: str
    chain_space_id: str | None = None
    #: Decrypted on this device; None while locked.
    name: str | None = None
    mode: str
    key_epoch: int
    quota_bytes: int | None = None
    used_bytes: int | None = None
    created_at: str | None = None


class Folder(Model):
    id: str
    space_id: str
    parent_id: str | None = None
    #: Decrypted on this device; None while locked.
    name: str | None = None
    memory_mode: str = "off"
    created_at: str | None = None


class FileInfo(Model):
    id: str
    space_id: str | None = None
    folder_id: str | None = None
    kind: Any = None
    status: str | None = None
    cid: str | None = None
    size_bytes: int | None = None
    segment_id: str | None = None
    previous_version_id: str | None = None
    key_epoch: int | None = None
    created_at: str | None = None
    tombstoned_at: str | None = None
    #: Decrypted on this device; None while locked or when the key is not yours.
    name: str | None = None
    mime: str | None = None
    size: int | None = None
    #: When it leaves the chain unless renewed. Listings only; the keeper renews it first.
    expires_at_block: int | None = None


class FilePage(Model):
    items: list[FileInfo]
    next_cursor: str | None = None
    head_block: int | None = None


class FileData(Model):
    data: bytes = Field(exclude=True)
    name: str
    mime: str


class PutResult(Model):
    file: FileInfo
    job: Job


class BlobCheck(Model):
    cid: str
    #: The bytes a node returned hash to the CID.
    retrievable: bool
    #: The block's TransactionStorage list holds this content hash at this position.
    on_chain: bool
    #: False when a node never answered, so the two checks above say nothing either way.
    answered: bool
    block: int | None = None
    index: int | None = None


class VerifyResult(Model):
    ok: bool
    #: Not ok, but nothing mismatched: a node did not answer in time. Try again.
    inconclusive: bool
    blobs: list[BlobCheck]


class Grant(Model):
    id: str
    space_id: str
    object_id: str | None = None
    grantee_kind: str
    grantee: str
    scope: str
    status: str
    wrapped_key_cid: str | None = None
    key_epoch: int | None = None
    space_key_epoch: int | None = None
    owner: str | None = None
    expires_at: str | None = None
    created_at: str | None = None
    revoked_at: str | None = None


class SharedDetails(Model):
    grant_id: str
    space_id: str
    object_id: str | None = None
    owner: str | None = None
    space_key_epoch: int | None = None
    key_epoch: int | None = None
    scope: str | None = None
    expires_at: str | None = None
    #: The space's name, or the file's.
    name: str | None = None


class Recipient(Model):
    account_id: str
    address: str
    registered: bool
    encryption_key: str | None = None


class ApiKey(Model):
    id: str
    name: str | None = None
    start: str | None = None
    role: str | None = None
    space_ids: list[str] | None = None
    agent_id: str | None = None
    last_used_at: str | None = None
    expires_at: str | None = None
    created_at: str | None = None


class NewApiKey(ApiKey):
    #: The full key, shown once.
    key: str | None = None


class Agent(Model):
    id: str
    label: str
    client: str | None = None
    kind: str | None = None
    public_key: str | None = None
    role: str | None = None
    space_ids: list[str] | None = None
    namespace_id: str | None = None
    expires_at: str | None = None
    created_at: str | None = None
    last_used_at: str | None = None
    revoked_at: str | None = None


class ConnectRequest(Model):
    id: str
    label: str
    client: str | None = None
    public_key: str
    requested_from: str | None = None
    status: str
    expires_at: str | None = None


class ConnectStart(Model):
    id: str
    #: Shown in both places, so the owner can tell it's their own terminal asking.
    code: str
    #: Where the owner approves it.
    url: str
    poll_secret: str
    poll_interval_seconds: int
    expires_at: str


class ConnectResult(Model):
    status: str
    #: Opened on this device, only when status is approved.
    api_key: str | None = None
    agent_id: str | None = None
    namespace_id: str | None = None
    #: The account that approved it.
    owner_account: str | None = None


class Usage(Model):
    spaces: list[Any] = []
    blobs: dict[str, Any] = {}
    stored_bytes: int | None = None
    renewals: int | None = None
    spent_planck: str | None = None
    next_renewal_block: int | None = None
    head_block: int | None = None


class Namespace(Model):
    id: str
    space_id: str
    #: Decrypted on this device; None while locked.
    name: str | None = None
    mode: str
    total_memories: int = 0
    segments: int = 0
    last_write: str | None = None
    created_at: str | None = None


class MemorySource(Model):
    kind: str
    object_id: str | None = None
    label: str | None = None


class Memory(Model):
    """A memory, whichever mode it's in."""

    id: str
    memory: str
    namespace_id: str | None = None
    user_id: str | None = None
    agent_id: str | None = None
    run_id: str | None = None
    metadata: dict[str, Any] | None = None
    categories: list[str] | None = None
    memory_type: str | None = None
    attributed_to: str | None = None
    source: MemorySource | None = None
    raw: bool = False
    immutable: bool = False
    version: int = 1
    feedback: str | None = None
    expiration_date: str | None = None
    occurred_at: str | None = None
    created_at: str | None = None
    updated_at: str | None = None
    #: Where the current version is stored. None while it's on its way, or until it's looked up.
    segment: dict[str, Any] | None = None
    mode: str = "assisted"


class ScoreBreakdown(Model):
    semantic: float = 0
    bm25: float = 0
    entity: float = 0


class ScoredMemory(Memory):
    score: float = 0
    score_breakdown: ScoreBreakdown = ScoreBreakdown()
    rerank_score: float | None = None


class MemoryPage(Model):
    results: list[Memory]
    count: int
    next_cursor: str | None = None


class AddedMemory(WireModel):
    id: str
    memory: str | None = None
    event: str


class AddResult(Model):
    #: Follow it with `memories.event`, or `jobs.wait_for` for each step. None if nothing was written.
    event_id: str | None = None
    status: str
    namespace_id: str | None = None
    results: list[AddedMemory] = []
    duplicates: int = 0
    #: Why this was stored differently than asked.
    note: str | None = None


class MemoryEvent(WireModel):
    id: str
    event_type: str | None = None
    status: str
    results: list[AddedMemory] = []
    duplicates: int = 0
    indexed: bool = False
    note: str | None = None
    error: str | None = None
    tx_hash: str | None = None
    block: int | None = None
    created_at: str | None = None
    updated_at: str | None = None


class HistoryEvent(Model):
    event: str
    old_memory: str | None = None
    new_memory: str | None = None
    actor: str | None = None
    created_at: str | None = None


class Entity(Model):
    id: str
    type: str
    total_memories: int = 0
    created_at: str | None = None
    updated_at: str | None = None
    namespace_id: str | None = None


class ExportFailure(Model):
    item: str
    reason: str


class ArchiveExport(Model):
    zip: bytes = Field(exclude=True)
    manifest: dict[str, Any]
    #: Files that couldn't be read back. They are named, never silently left out.
    failures: list[ExportFailure] = []


class ImportReport(Model):
    spaces: int = 0
    folders: int = 0
    files: int = 0
    memories: int = 0
    duplicates: int = 0
    #: What couldn't be brought in, and why. A full space stops its files, not the whole import.
    failures: list[ExportFailure] = []
