"""Database — asyncpg connection pool with pgvector codec.

Creates a shared connection pool on startup and provides helpers for
common query patterns. The pool is closed gracefully on shutdown.

pgvector's Python library registers a custom codec so asyncpg can
transparently encode/decode `vector` columns as Python lists of floats.
"""

from __future__ import annotations

import logging
from typing import Any

import asyncpg
from pgvector.asyncpg import register_vector

logger = logging.getLogger("agent-api.db")

# Module-level pool — initialized by init_db(), closed by close_db().
_pool: asyncpg.Pool | None = None


async def init_db(database_url: str) -> asyncpg.Pool:
    """Create the connection pool and register pgvector codec."""
    global _pool
    if _pool is not None:
        return _pool

    logger.info("Creating database connection pool…")
    _pool = await asyncpg.create_pool(
        database_url,
        min_size=2,
        max_size=10,
        # Register pgvector codec on every new connection in the pool.
        init=_init_connection,
    )
    logger.info("Database pool ready (min=2, max=10)")
    return _pool


async def _init_connection(conn: asyncpg.Connection) -> None:
    """Called once for each new connection in the pool."""
    await register_vector(conn)


async def close_db() -> None:
    """Drain and close the pool. Called on app shutdown."""
    global _pool
    if _pool is not None:
        logger.info("Closing database pool…")
        await _pool.close()
        _pool = None


def get_pool() -> asyncpg.Pool:
    """Get the current pool. Raises if init_db hasn't been called."""
    if _pool is None:
        raise RuntimeError("Database pool not initialized — call init_db() first")
    return _pool


# ─── Query helpers ──────────────────────────────────────────────


async def fetch_all(
    query: str, *args: Any, pool: asyncpg.Pool | None = None
) -> list[dict[str, Any]]:
    """Execute a SELECT and return all rows as dicts."""
    p = pool or get_pool()
    rows = await p.fetch(query, *args)
    return [dict(r) for r in rows]


async def fetch_one(
    query: str, *args: Any, pool: asyncpg.Pool | None = None
) -> dict[str, Any] | None:
    """Execute a SELECT and return first row as dict, or None."""
    p = pool or get_pool()
    row = await p.fetchrow(query, *args)
    return dict(row) if row else None


async def execute(
    query: str, *args: Any, pool: asyncpg.Pool | None = None
) -> str:
    """Execute a non-SELECT statement. Returns status string."""
    p = pool or get_pool()
    return await p.execute(query, *args)
