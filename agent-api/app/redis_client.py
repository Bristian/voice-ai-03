"""Redis client — async connection for sessions, caching, and pub/sub.

Creates a shared Redis connection on startup using redis-py's async API.
The connection uses hiredis for faster parsing when available (it's in
our requirements).
"""

from __future__ import annotations

import json
import logging
from typing import Any

import redis.asyncio as aioredis

logger = logging.getLogger("agent-api.redis")

_redis: aioredis.Redis | None = None


async def init_redis(redis_url: str) -> aioredis.Redis:
    """Connect to Redis and verify with PING."""
    global _redis
    if _redis is not None:
        return _redis

    logger.info("Connecting to Redis…")
    _redis = aioredis.from_url(
        redis_url,
        decode_responses=False,  # we store both text JSON and binary blobs
        socket_connect_timeout=5,
        retry_on_timeout=True,
    )
    await _redis.ping()
    logger.info("Redis connected")
    return _redis


async def close_redis() -> None:
    """Close the Redis connection pool. Called on app shutdown."""
    global _redis
    if _redis is not None:
        logger.info("Closing Redis connection…")
        await _redis.aclose()
        _redis = None


def get_redis() -> aioredis.Redis:
    """Get the current Redis client. Raises if not initialized."""
    if _redis is None:
        raise RuntimeError("Redis not initialized — call init_redis() first")
    return _redis


# ─── Convenience wrappers for JSON cache patterns ──────────────


async def cache_get_json(key: str) -> Any | None:
    """Get a JSON-serialized value from Redis. Returns None on miss."""
    r = get_redis()
    raw = await r.get(key)
    if raw is None:
        return None
    return json.loads(raw)


async def cache_set_json(key: str, value: Any, ttl_seconds: int) -> None:
    """Set a JSON-serialized value in Redis with TTL."""
    r = get_redis()
    await r.set(key, json.dumps(value), ex=ttl_seconds)


async def cache_get_bytes(key: str) -> bytes | None:
    """Get raw bytes from Redis. Returns None on miss."""
    r = get_redis()
    return await r.get(key)


async def cache_set_bytes(key: str, value: bytes, ttl_seconds: int) -> None:
    """Set raw bytes in Redis with TTL."""
    r = get_redis()
    await r.set(key, value, ex=ttl_seconds)
