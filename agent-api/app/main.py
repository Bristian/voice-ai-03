"""FastAPI application — routes, startup/shutdown, middleware.

This is the entry point for the agent-api service. uvicorn runs this as:
    uvicorn app.main:app --host 0.0.0.0 --port $PORT

Routes:
    POST /v1/agent/turn     — full conversational turn (primary)
    POST /v1/rag/query      — RAG-only retrieval
    POST /v1/sql/search     — Voice-to-SQL vehicle search
    POST /v1/embeddings     — batch embedding (for ingestion-worker)
    GET  /healthz            — liveness probe
    GET  /                   — human-readable info
"""

from __future__ import annotations

import logging
import time
from contextlib import asynccontextmanager
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse, PlainTextResponse
from pydantic import BaseModel, Field

from app.config import Settings, get_settings
from app.db import close_db, fetch_one, init_db
from app.redis_client import close_redis, get_redis, init_redis
from app.embeddings import embed_batch, init_embeddings
from app.intent import init_intent
from app.rag import init_rag
from app.sql_agent import init_sql_agent
from app.synthesis import init_synthesis
from app.agent import init_agent, process_turn

from voiceai_contracts.agent_turn import AgentTurnRequest, AgentTurnResponse
from voiceai_contracts.session import SessionEntities

# ─── Logging ──────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s [%(name)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("agent-api")

# ─── Settings ─────────────────────────────────────────────

settings = get_settings()

# ─── Lifespan (startup + shutdown) ────────────────────────


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize connections on startup, close on shutdown."""
    logger.info("Starting agent-api…")

    # Database
    await init_db(settings.database_url)

    # Redis
    await init_redis(settings.redis_url)

    # OpenAI clients for each module
    init_embeddings(settings)
    init_intent(settings)
    init_rag(settings)
    init_sql_agent(settings)
    init_synthesis(settings)
    init_agent(settings)

    # Load knowledge base into the unified turn module so it can answer
    # FAQ/policy/financing questions in a single LLM call.
    try:
        from app.db import fetch_all
        from app.unified_turn import init_unified
        chunks = await fetch_all(
            "SELECT source, content, metadata FROM knowledge_chunks ORDER BY source, created_at"
        )
        init_unified(settings, knowledge_chunks=chunks)
    except Exception as e:
        logger.warning("Failed to load knowledge base for unified turn: %s", e)
        # Non-fatal: the system will fall back to the two-call pipeline
        from app.unified_turn import init_unified
        init_unified(settings)

    logger.info(
        "agent-api ready (port=%d, auth=%s)",
        settings.port,
        "enabled" if settings.auth_enabled else "disabled",
    )

    yield  # App runs here

    # Shutdown
    logger.info("Shutting down agent-api…")
    await close_redis()
    await close_db()
    logger.info("agent-api stopped")


# ─── App ──────────────────────────────────────────────────

app = FastAPI(
    title="Car Dealership Voice AI — Agent API",
    version="0.2.0",
    lifespan=lifespan,
)

# ─── Auth dependency ──────────────────────────────────────


async def verify_auth(authorization: str | None = Header(default=None)):
    """Optional Bearer token auth. Disabled when INTERNAL_API_SECRET is empty."""
    if not settings.auth_enabled:
        return
    if not authorization:
        raise HTTPException(401, "Missing Authorization header")
    parts = authorization.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(401, "Invalid Authorization format (expected: Bearer <token>)")
    if parts[1] != settings.internal_api_secret:
        raise HTTPException(401, "Invalid API secret")


# ─── Health + info ────────────────────────────────────────


@app.get("/healthz")
async def healthz():
    """Liveness probe. Checks DB + Redis connectivity."""
    checks: dict[str, str] = {}
    status = "ok"

    # DB check
    try:
        row = await fetch_one("SELECT 1 AS ping")
        checks["postgres"] = "ok" if row else "unreachable"
    except Exception as e:
        checks["postgres"] = f"error: {e}"
        status = "degraded"

    # Redis check
    try:
        r = get_redis()
        await r.ping()
        checks["redis"] = "ok"
    except Exception as e:
        checks["redis"] = f"error: {e}"
        status = "degraded"

    return {
        "status": status,
        "service": "agent-api",
        "checks": checks,
    }


@app.get("/", response_class=PlainTextResponse)
async def root():
    return (
        "agent-api is running.\n\n"
        "Endpoints:\n"
        "  GET  /healthz          — liveness probe\n"
        "  POST /v1/agent/turn    — full conversational turn\n"
        "  POST /v1/rag/query     — RAG-only retrieval\n"
        "  POST /v1/sql/search    — Voice-to-SQL vehicle search\n"
        "  POST /v1/embeddings    — batch embedding\n\n"
        f"Version: 0.3.0 (slice 3)\n"
        f"Auth: {'enabled' if settings.auth_enabled else 'disabled'}\n"
    )


# ─── POST /v1/agent/turn ─────────────────────────────────


@app.post("/v1/agent/turn", response_model=AgentTurnResponse)
async def agent_turn(
    request: AgentTurnRequest,
    _auth: None = Depends(verify_auth),
):
    """Execute a full conversational turn: intent → parallel RAG + SQL → synthesis."""
    t0 = time.monotonic()
    try:
        response = await process_turn(request)
        logger.info(
            "Turn completed in %.0fms: intent=%s action=%s",
            (time.monotonic() - t0) * 1000,
            response.intent.value,
            response.action.value,
        )
        return response
    except Exception as e:
        logger.error("Turn failed: %s", e, exc_info=True)
        raise HTTPException(500, f"Agent turn failed: {e}")


# ─── POST /v1/rag/query ──────────────────────────────────


class RagQueryRequest(BaseModel):
    query: str
    top_k: int = Field(default=5, ge=1, le=20)
    metadata_filter: dict[str, Any] | None = None


class RagQueryResponse(BaseModel):
    answer: str | None = None
    grounded: bool
    chunks: list[dict]


@app.post("/v1/rag/query", response_model=RagQueryResponse)
async def rag_query(
    request: RagQueryRequest,
    _auth: None = Depends(verify_auth),
):
    """RAG-only retrieval and grounded generation."""
    from app.rag import is_grounded, retrieve_chunks
    from app.synthesis import synthesize_response

    chunks = await retrieve_chunks(
        request.query,
        top_k=request.top_k,
    )
    grounded = is_grounded(chunks)

    answer = None
    if grounded and chunks:
        answer = await synthesize_response(
            transcript=request.query,
            intent="dealership_info",
            rag_chunks=chunks,
        )

    return RagQueryResponse(
        answer=answer,
        grounded=grounded,
        chunks=[
            {
                "id": str(c.get("id", "")),
                "source": c.get("source", "faq"),
                "content": c.get("content", ""),
                "score": round(float(c.get("score", 0)), 4),
            }
            for c in chunks
        ],
    )


# ─── POST /v1/sql/search ─────────────────────────────────


class SqlSearchRequest(BaseModel):
    entities: SessionEntities = Field(default_factory=SessionEntities)
    limit: int = Field(default=5, ge=1, le=10)


@app.post("/v1/sql/search")
async def sql_search(
    request: SqlSearchRequest,
    _auth: None = Depends(verify_auth),
):
    """Voice-to-SQL vehicle search. Uses fast template first, LLM fallback."""
    from app.sql_agent import template_search, generate_and_execute

    result = await template_search(request.entities, limit=request.limit)
    if not result.get("vehicles"):
        # Template found nothing — try LLM-generated SQL
        result = await generate_and_execute(request.entities, limit=request.limit)
    return result


# ─── POST /v1/embeddings ─────────────────────────────────


class EmbedRequest(BaseModel):
    texts: list[str] = Field(min_length=1, max_length=100)
    cache: bool = True


class EmbedResponse(BaseModel):
    embeddings: list[list[float]]


@app.post("/v1/embeddings", response_model=EmbedResponse)
async def create_embeddings(
    request: EmbedRequest,
    _auth: None = Depends(verify_auth),
):
    """Batch embedding endpoint, used by ingestion-worker."""
    vectors = await embed_batch(request.texts, use_cache=request.cache)
    return EmbedResponse(embeddings=vectors)


# ─── Global error handler ────────────────────────────────


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error("Unhandled exception on %s: %s", request.url.path, exc, exc_info=True)
    return JSONResponse(
        status_code=500,
        content={
            "error": {
                "code": "INTERNAL_ERROR",
                "message": str(exc),
            }
        },
    )
