"""Embedding on this machine, so Private memories never leave it in the clear.

The same model and quantization the TypeScript SDK and the dashboard use, so an index built on one
device can be read on another. Install it with `pip install "memdot[local]"`.
"""

from __future__ import annotations

from typing import Any, Protocol

from .engine import LOCAL_EMBEDDING_MODEL

_REPO = LOCAL_EMBEDDING_MODEL["id"]
_WEIGHTS = "onnx/model_quantized.onnx"
_MAX_TOKENS = 512


class Embedder(Protocol):
    """Turns texts into unit vectors. Queries and documents can embed differently on some models."""

    model_id: str
    dimensions: int

    def embed(self, texts: list[str], purpose: str) -> list[list[float]]: ...


class EmbedderMissing(RuntimeError):
    """The optional runtime isn't installed: search falls back to words."""


class LocalEmbedder:
    """Downloads the model once (about 23 MB), then runs on this machine with onnxruntime."""

    model_id = str(LOCAL_EMBEDDING_MODEL["id"])
    dimensions = int(LOCAL_EMBEDDING_MODEL["dimensions"])

    def __init__(self) -> None:
        self._session: Any = None
        self._tokenizer: Any = None
        self._numpy: Any = None

    def _load(self) -> None:
        if self._session is not None:
            return
        try:
            import numpy
            import onnxruntime
            from huggingface_hub import hf_hub_download
            from huggingface_hub.utils import logging as hf_logging
            from tokenizers import Tokenizer
        except ImportError as error:
            raise EmbedderMissing(
                'Searching by meaning needs the local model: pip install "memdot[local]"'
            ) from error
        # It would warn about having no token on every run, on stderr, for a public model.
        hf_logging.set_verbosity_error()
        tokenizer = Tokenizer.from_file(hf_hub_download(_REPO, "tokenizer.json"))
        tokenizer.enable_padding()
        tokenizer.enable_truncation(max_length=_MAX_TOKENS)
        self._tokenizer = tokenizer
        self._numpy = numpy
        self._session = onnxruntime.InferenceSession(
            hf_hub_download(_REPO, _WEIGHTS), providers=["CPUExecutionProvider"]
        )

    def embed(self, texts: list[str], purpose: str = "document") -> list[list[float]]:
        if not texts:
            return []
        self._load()
        numpy = self._numpy
        encoded = self._tokenizer.encode_batch(texts)
        ids = numpy.array([e.ids for e in encoded], dtype=numpy.int64)
        mask = numpy.array([e.attention_mask for e in encoded], dtype=numpy.int64)
        types = numpy.array([e.type_ids for e in encoded], dtype=numpy.int64)
        hidden = self._session.run(
            None, {"input_ids": ids, "attention_mask": mask, "token_type_ids": types}
        )[0]
        weights = mask[..., None].astype(numpy.float32)
        pooled = (hidden * weights).sum(axis=1) / numpy.clip(weights.sum(axis=1), 1e-9, None)
        lengths = numpy.linalg.norm(pooled, axis=1, keepdims=True)
        return (pooled / numpy.clip(lengths, 1e-12, None)).tolist()
