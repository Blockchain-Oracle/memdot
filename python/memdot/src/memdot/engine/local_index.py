"""A Private namespace's index, in memory on this machine, and its encrypted snapshot format."""

from __future__ import annotations

import json
import math
import struct
from array import array
from collections.abc import Callable, Iterable
from typing import Any

from ..crypto import dumps
from .tokenize import term_frequencies

try:
    import numpy as _np
except ImportError:  # numpy comes with the `local` extra; the index works without it, just slower.
    _np = None

_MAGIC = b"MDIDX1"
_INT8_SCALE = 127
_BM25_K1 = 1.2
_BM25_B = 0.75


class _Document:
    __slots__ = ("length", "terms", "vector", "version")

    def __init__(self, version: int, terms: dict[str, int], length: int, vector: array | None):
        self.version = version
        self.terms = terms
        self.length = length
        self.vector = vector


def _as_vector(values: Iterable[float]) -> array:
    # Single precision, like the TypeScript index, so scores agree between the two.
    return array("f", values)


class LocalIndex:
    """Brute force is fast at this scale, and the whole index fits one encrypted snapshot."""

    def __init__(self, model_id: str, dtype: str, dimensions: int) -> None:
        self.model_id = model_id
        self.dtype = dtype
        self.dimensions = dimensions
        self._docs: dict[str, _Document] = {}
        self._document_frequency: dict[str, int] = {}
        self._total_length = 0

    @property
    def size(self) -> int:
        return len(self._docs)

    def ids(self) -> list[str]:
        return list(self._docs)

    def version(self, memory_id: str) -> int | None:
        doc = self._docs.get(memory_id)
        return doc.version if doc else None

    def has_vector(self, memory_id: str) -> bool:
        doc = self._docs.get(memory_id)
        return doc is not None and doc.vector is not None

    def put(
        self,
        memory_id: str,
        version: int,
        text: str,
        vector: Iterable[float] | None = None,
    ) -> None:
        self.remove(memory_id)
        terms = term_frequencies(text)
        length = 0
        for term, count in terms.items():
            length += count
            self._document_frequency[term] = self._document_frequency.get(term, 0) + 1
        self._total_length += length
        self._docs[memory_id] = _Document(
            version, terms, length, _as_vector(vector) if vector is not None else None
        )

    def set_vector(self, memory_id: str, vector: Iterable[float]) -> None:
        doc = self._docs.get(memory_id)
        if doc:
            doc.vector = _as_vector(vector)

    def remove(self, memory_id: str) -> None:
        doc = self._docs.pop(memory_id, None)
        if not doc:
            return
        for term in doc.terms:
            left = self._document_frequency.get(term, 1) - 1
            if left == 0:
                self._document_frequency.pop(term, None)
            else:
                self._document_frequency[term] = left
        self._total_length -= doc.length

    def semantic(
        self,
        query: Iterable[float],
        limit: int,
        allow: Callable[[str], bool] | None = None,
    ) -> list[dict[str, Any]]:
        """Cosine similarity for every document that has a vector, best first."""
        wanted = [
            (memory_id, doc.vector)
            for memory_id, doc in self._docs.items()
            if doc.vector is not None and (allow is None or allow(memory_id))
        ]
        if not wanted:
            return []
        query_list = list(query)
        if _np is not None:
            matrix = _np.array([vector for _, vector in wanted], dtype=_np.float64)
            scores = (matrix @ _np.array(query_list, dtype=_np.float64)).tolist()
        else:
            scores = [
                math.fsum(a * b for a, b in zip(query_list, vector, strict=False))
                for _, vector in wanted
            ]
        scored = [
            {"id": item[0], "score": score} for item, score in zip(wanted, scores, strict=True)
        ]
        scored.sort(key=lambda hit: -hit["score"])
        return scored[:limit]

    def keyword(
        self,
        query_terms: Iterable[str],
        limit: int,
        allow: Callable[[str], bool] | None = None,
    ) -> list[dict[str, Any]]:
        """Okapi BM25 over the query's terms, best first."""
        if not self._docs:
            return []
        average = (self._total_length / len(self._docs)) or 1
        unique = list(dict.fromkeys(query_terms))
        scored: list[dict[str, Any]] = []
        for memory_id, doc in self._docs.items():
            if allow is not None and not allow(memory_id):
                continue
            score = 0.0
            for term in unique:
                tf = doc.terms.get(term)
                if not tf:
                    continue
                df = self._document_frequency.get(term, 0)
                idf = math.log(1 + (len(self._docs) - df + 0.5) / (df + 0.5))
                score += (idf * (tf * (_BM25_K1 + 1))) / (
                    tf + _BM25_K1 * (1 - _BM25_B + (_BM25_B * doc.length) / average)
                )
            if score > 0:
                scored.append({"id": memory_id, "score": score})
        scored.sort(key=lambda hit: -hit["score"])
        return scored[:limit]

    def to_snapshot(self, at: str) -> bytes:
        """Vectors at one byte per component, so a snapshot costs a quarter of the tPOT."""
        entries = [(i, doc) for i, doc in self._docs.items() if doc.vector is not None]
        header = dumps(
            {
                "v": 1,
                "modelId": self.model_id,
                "dtype": self.dtype,
                "dimensions": self.dimensions,
                "ids": [i for i, _ in entries],
                "versions": [doc.version for _, doc in entries],
                "at": at,
            }
        )
        matrix = bytearray()
        for _, doc in entries:
            vector = doc.vector or []
            for i in range(self.dimensions):
                # Math.round, which `round` isn't: halves go up here, and to even there.
                matrix += struct.pack("b", math.floor(vector[i] * _INT8_SCALE + 0.5))
        return _MAGIC + struct.pack(">I", len(header)) + header + bytes(matrix)


def read_snapshot(
    data: bytes, *, model_id: str, dtype: str, dimensions: int
) -> dict[str, tuple[int, list[float]]] | None:
    """Vectors in a snapshot by memory id. None when the embedding model has changed."""
    if not data.startswith(_MAGIC):
        raise ValueError("not a MemDot index snapshot")
    start = len(_MAGIC) + 4
    (header_length,) = struct.unpack(">I", data[len(_MAGIC) : start])
    header = json.loads(data[start : start + header_length])
    if (
        header.get("v") != 1
        or header.get("modelId") != model_id
        or header.get("dtype") != dtype
        or header.get("dimensions") != dimensions
    ):
        return None
    matrix = data[start + header_length :]
    vectors: dict[str, tuple[int, list[float]]] = {}
    for row, memory_id in enumerate(header["ids"]):
        begin = row * header["dimensions"]
        values = struct.unpack(
            f"{header['dimensions']}b", matrix[begin : begin + header["dimensions"]]
        )
        vectors[memory_id] = (header["versions"][row], [v / _INT8_SCALE for v in values])
    return vectors
