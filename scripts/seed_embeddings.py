#!/usr/bin/env python3
"""Seed embeddings for vehicles and knowledge chunks.

Reads records missing embeddings from PostgreSQL, sends their text to the
agent-api's /v1/embeddings endpoint in batches, and updates the rows.

Usage:
    export DATABASE_URL="postgresql://..."
    export AGENT_API_URL="https://agent-api-production-xxxx.up.railway.app"
    python3 scripts/seed_embeddings.py

Prerequisites:
    pip install httpx asyncpg
"""

from __future__ import annotations

import asyncio
import json
import os
import sys

import asyncpg
import httpx


DATABASE_URL = os.environ.get("DATABASE_URL", "")
AGENT_API_URL = os.environ.get("AGENT_API_URL", "").rstrip("/")
BATCH_SIZE = 20  # OpenAI handles up to ~100 but keep small for seed data


async def main():
    if not DATABASE_URL:
        print("ERROR: Set DATABASE_URL environment variable")
        sys.exit(1)
    if not AGENT_API_URL:
        print("ERROR: Set AGENT_API_URL environment variable")
        sys.exit(1)

    print(f"Connecting to database…")
    conn = await asyncpg.connect(DATABASE_URL)

    # Register pgvector so we can write vector columns
    await conn.execute("CREATE EXTENSION IF NOT EXISTS vector")
    from pgvector.asyncpg import register_vector
    await register_vector(conn)

    async with httpx.AsyncClient(timeout=60) as client:
        # ── Vehicles ──
        rows = await conn.fetch(
            "SELECT id, description FROM vehicles WHERE embedding IS NULL AND description IS NOT NULL"
        )
        print(f"Vehicles needing embeddings: {len(rows)}")
        await embed_and_update(client, conn, rows, "vehicles", "description")

        # ── Knowledge chunks ──
        rows = await conn.fetch(
            "SELECT id, content FROM knowledge_chunks WHERE embedding IS NULL"
        )
        print(f"Knowledge chunks needing embeddings: {len(rows)}")
        await embed_and_update(client, conn, rows, "knowledge_chunks", "content")

    await conn.close()
    print("\nDone!")


async def embed_and_update(
    client: httpx.AsyncClient,
    conn: asyncpg.Connection,
    rows: list,
    table: str,
    text_column: str,
):
    """Embed texts via API and update the database."""
    import numpy as np

    for i in range(0, len(rows), BATCH_SIZE):
        batch = rows[i : i + BATCH_SIZE]
        texts = [r[text_column] for r in batch]
        ids = [r["id"] for r in batch]

        print(f"  Embedding batch {i // BATCH_SIZE + 1} ({len(batch)} texts)…")
        resp = await client.post(
            f"{AGENT_API_URL}/v1/embeddings",
            json={"texts": texts, "cache": True},
        )
        if resp.status_code != 200:
            print(f"  ERROR: {resp.status_code} — {resp.text[:200]}")
            continue

        data = resp.json()
        embeddings = data["embeddings"]

        for row_id, vec in zip(ids, embeddings):
            vec_np = np.array(vec, dtype=np.float32)
            await conn.execute(
                f"UPDATE {table} SET embedding = $1 WHERE id = $2",
                vec_np,
                row_id,
            )

        print(f"  Updated {len(batch)} rows in {table}")


if __name__ == "__main__":
    asyncio.run(main())
