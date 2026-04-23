"""RAG pipeline — embed → pgvector HNSW search → rerank → grounded response.

Handles FAQ, policy, financing, promo, and service questions by finding
relevant knowledge chunks and grounding the LLM's answer in them.

Flow:
  1. Embed the user's query via embeddings.py (cached)
  2. pgvector cosine similarity search on knowledge_chunks (top-k=5)
  3. Cross-encoder rerank to top-3
  4. Check if best score is above hallucination threshold
  5. Return chunks + grounded flag
"""

from __future__ import annotations

import logging
import time
from typing import Sequence

import numpy as np

from app.config import Settings
from app.db import fetch_all
from app.embeddings import embed_single

logger = logging.getLogger("agent-api.rag")

_settings: Settings | None = None

# Cross-encoder is loaded lazily on first use to avoid import-time model download.
_reranker = None
_reranker_loaded = False


def init_rag(settings: Settings) -> None:
    global _settings
    _settings = settings


def _get_reranker():
    """Lazy-load the cross-encoder model. ~200MB download on first call."""
    global _reranker, _reranker_loaded
    if _reranker_loaded:
        return _reranker
    try:
        from sentence_transformers import CrossEncoder
        logger.info("Loading cross-encoder reranker (first call — may download model)…")
        _reranker = CrossEncoder("cross-encoder/ms-marco-MiniLM-L-6-v2")
        logger.info("Reranker loaded")
    except Exception as e:
        logger.warning("Failed to load reranker: %s. Will skip reranking.", e)
        _reranker = None
    _reranker_loaded = True
    return _reranker


async def retrieve_chunks(
    query: str,
    source_filter: Sequence[str] | None = None,
    top_k: int | None = None,
) -> list[dict]:
    """Embed query, search pgvector, rerank, return top chunks with scores.

    Each returned dict has: id, source, content, metadata, score.
    Score is from the cross-encoder (0-1ish) if available, else raw cosine.
    """
    assert _settings is not None
    k = top_k or _settings.rag_top_k

    t0 = time.monotonic()

    # Step 1: embed the query
    query_vec = await embed_single(query)

    # Step 2: pgvector search
    # Format vector as pgvector literal: '[0.1,0.2,...]' (no spaces)
    vec_literal = "[" + ",".join(str(f) for f in query_vec) + "]"

    # Build the WHERE clause for optional source filtering
    if source_filter:
        placeholders = ", ".join(f"${i+2}" for i in range(len(source_filter)))
        where_clause = f"AND source IN ({placeholders})"
        params: list = [vec_literal, *source_filter]
    else:
        where_clause = ""
        params = [vec_literal]

    sql = f"""
        SELECT id, source, content, metadata,
               embedding <=> $1::vector AS distance
        FROM knowledge_chunks
        WHERE embedding IS NOT NULL
        {where_clause}
        ORDER BY distance ASC
        LIMIT {k}
    """
    rows = await fetch_all(sql, *params)
    embed_ms = (time.monotonic() - t0) * 1000

    if not rows:
        logger.info("RAG: no chunks found (%.0fms)", embed_ms)
        return []

    # Step 3: cross-encoder rerank
    reranker = _get_reranker()
    if reranker is not None and len(rows) > 1:
        pairs = [(query, row["content"]) for row in rows]
        scores = reranker.predict(pairs)
        for i, row in enumerate(rows):
            row["score"] = float(scores[i])
        rows.sort(key=lambda r: r["score"], reverse=True)
    else:
        # Use (1 - cosine distance) as a rough score
        for row in rows:
            row["score"] = 1.0 - float(row.get("distance", 0.5))

    # Trim to rerank top
    top_n = _settings.rag_rerank_top
    rows = rows[:top_n]

    total_ms = (time.monotonic() - t0) * 1000
    logger.info(
        "RAG: retrieved %d chunks, top score=%.3f (embed %.0fms, total %.0fms)",
        len(rows), rows[0]["score"] if rows else 0, embed_ms, total_ms,
    )
    return rows


def is_grounded(chunks: list[dict]) -> bool:
    """Check if the best chunk score is above the hallucination threshold.

    If False, the caller should trigger a human transfer rather than
    generating an answer that might hallucinate.
    """
    assert _settings is not None
    if not chunks:
        return False
    return chunks[0].get("score", 0) >= _settings.rag_hallucination_threshold
