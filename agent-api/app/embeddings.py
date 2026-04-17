"""Embeddings — OpenAI text-embedding-3-small with Redis cache.

Every text → vector conversion goes through here. The cache key is
`embed_cache:{sha256(text)}` with a configurable TTL (default 1h).

This module is used by:
  - rag.py (embed the user's query for pgvector search)
  - sql_agent.py (not directly, but could be used for hybrid search)
  - main.py /v1/embeddings endpoint (batch embedding for ingestion-worker)
"""

from __future__ import annotations

import hashlib
import json
import logging
from typing import Sequence

import numpy as np
from openai import AsyncOpenAI

from app.config import Settings
from app.redis_client import cache_get_bytes, cache_set_bytes

logger = logging.getLogger("agent-api.embeddings")

_client: AsyncOpenAI | None = None
_settings: Settings | None = None


def init_embeddings(settings: Settings) -> None:
    global _client, _settings
    _client = AsyncOpenAI(api_key=settings.openai_api_key)
    _settings = settings


def _cache_key(text: str) -> str:
    h = hashlib.sha256(text.encode("utf-8")).hexdigest()
    return f"embed_cache:{h}"


async def embed_single(text: str) -> list[float]:
    """Embed a single text string, with cache."""
    assert _client is not None and _settings is not None

    key = _cache_key(text)
    cached = await cache_get_bytes(key)
    if cached is not None:
        logger.debug("Embedding cache HIT for %s…", key[:30])
        return json.loads(cached)

    logger.debug("Embedding cache MISS — calling OpenAI for %d chars", len(text))
    resp = await _client.embeddings.create(
        model=_settings.embedding_model,
        input=text,
        dimensions=_settings.embedding_dims,
    )
    vec = resp.data[0].embedding

    await cache_set_bytes(
        key,
        json.dumps(vec).encode("utf-8"),
        _settings.embed_cache_ttl_seconds,
    )
    return vec


async def embed_batch(texts: Sequence[str], use_cache: bool = True) -> list[list[float]]:
    """Embed multiple texts. Checks cache per-item when use_cache=True.

    For texts that miss cache, batches them into a single OpenAI call.
    """
    assert _client is not None and _settings is not None

    results: list[list[float] | None] = [None] * len(texts)
    to_embed: list[tuple[int, str]] = []

    if use_cache:
        for i, text in enumerate(texts):
            key = _cache_key(text)
            cached = await cache_get_bytes(key)
            if cached is not None:
                results[i] = json.loads(cached)
            else:
                to_embed.append((i, text))
    else:
        to_embed = list(enumerate(texts))

    if to_embed:
        logger.info("Embedding %d texts via OpenAI (batch)", len(to_embed))
        texts_to_send = [t for _, t in to_embed]
        resp = await _client.embeddings.create(
            model=_settings.embedding_model,
            input=texts_to_send,
            dimensions=_settings.embedding_dims,
        )
        for j, item in enumerate(resp.data):
            orig_idx = to_embed[j][0]
            vec = item.embedding
            results[orig_idx] = vec
            if use_cache:
                key = _cache_key(to_embed[j][1])
                await cache_set_bytes(
                    key,
                    json.dumps(vec).encode("utf-8"),
                    _settings.embed_cache_ttl_seconds,
                )

    return results  # type: ignore[return-value]


def cosine_similarity(a: list[float], b: list[float]) -> float:
    """Compute cosine similarity between two vectors."""
    va = np.array(a, dtype=np.float32)
    vb = np.array(b, dtype=np.float32)
    return float(np.dot(va, vb) / (np.linalg.norm(va) * np.linalg.norm(vb) + 1e-10))
