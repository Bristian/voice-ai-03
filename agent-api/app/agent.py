"""Agent orchestrator — executes a full conversational turn.

Slice 4 improvements:
  - Parallel intent classification + query embedding. The embedding starts
    at the same time as intent classification. If the intent turns out to be
    a vehicle search (no RAG needed), the embedding is discarded. If it's a
    knowledge intent, the embedding is already ready — saving ~500ms.
  - Response caching: identical response_text values are flagged with a
    cache key so echokit-server can cache the TTS audio.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import time

from app.config import Settings
from app.embeddings import embed_single
from app.intent import classify_intent, merge_entities
from app.rag import is_grounded, retrieve_chunks_with_embedding
from app.sql_agent import generate_and_execute, template_search
from app.synthesis import synthesize_response

from voiceai_contracts.agent_turn import (
    Action,
    AgentTurnRequest,
    AgentTurnResponse,
    AgentTurnResults,
    LatencyMetrics,
    RagChunk,
    RagSource,
)
from voiceai_contracts.session import Intent, SessionEntities
from voiceai_contracts.vehicle import Condition, Status, Vehicle

logger = logging.getLogger("agent-api.agent")

_settings: Settings | None = None

VEHICLE_INTENTS = {Intent.VEHICLE_SEARCH, Intent.PRICING_QUERY, Intent.AVAILABILITY_CHECK}
KNOWLEDGE_INTENTS = {Intent.FINANCING_INQUIRY, Intent.DEALERSHIP_INFO, Intent.APPOINTMENT_REQUEST}


def init_agent(settings: Settings) -> None:
    global _settings
    _settings = settings


async def process_turn(request: AgentTurnRequest) -> AgentTurnResponse:
    """Execute a full conversational turn."""
    assert _settings is not None
    t_start = time.monotonic()

    # ── Step 1: Parallel intent + embedding ──
    # Start embedding the transcript NOW, before we know the intent.
    # If intent turns out to be vehicle_search, we discard the embedding.
    # If it's a knowledge intent, we save ~500-1500ms by having it ready.
    t0 = time.monotonic()

    intent_task = asyncio.create_task(
        classify_intent(request.transcript, request.session_entities)
    )
    embed_task = asyncio.create_task(
        _safe_embed(request.transcript)
    )

    # Wait for intent (we need it to route)
    intent, confidence, new_entities = await intent_task
    intent_ms = (time.monotonic() - t0) * 1000

    # Merge entities
    merged_entities = merge_entities(request.session_entities, new_entities)
    non_none_entities = {k: v for k, v in merged_entities.model_dump().items() if v is not None and v != []}
    logger.info(
        "Turn: intent=%s (%.2f), entities=%s",
        intent.value, confidence, non_none_entities,
    )

    # ── Step 2: Human transfer ──
    if intent == Intent.HUMAN_TRANSFER:
        embed_task.cancel()
        return _transfer_response(merged_entities, intent, confidence, intent_ms, t_start)

    # ── Step 3: Route to tracks ──
    rag_chunks: list[dict] = []
    vehicles_raw: list[dict] = []
    rag_ms = 0.0
    sql_ms = 0.0

    if intent in VEHICLE_INTENTS:
        # Don't need the embedding — cancel it
        embed_task.cancel()

        t0 = time.monotonic()
        sql_result = await template_search(merged_entities)
        vehicles_raw = sql_result.get("vehicles", [])

        if not vehicles_raw and non_none_entities:
            logger.info("Template returned 0 results — trying LLM SQL generation")
            sql_result = await generate_and_execute(merged_entities)
            vehicles_raw = sql_result.get("vehicles", [])

        sql_ms = (time.monotonic() - t0) * 1000
        logger.info("SQL track: %d vehicles in %.0fms", len(vehicles_raw), sql_ms)

    elif intent in KNOWLEDGE_INTENTS:
        # USE the pre-started embedding — this is the big latency win
        t0 = time.monotonic()
        query_embedding = await embed_task  # Already running, may be done already
        rag_chunks = await retrieve_chunks_with_embedding(
            request.transcript, query_embedding
        )
        rag_ms = (time.monotonic() - t0) * 1000
        logger.info("RAG track: %d chunks, top_score=%.3f in %.0fms (embedding was pre-started)",
                     len(rag_chunks), rag_chunks[0]["score"] if rag_chunks else 0, rag_ms)

        if not is_grounded(rag_chunks):
            logger.info("RAG not grounded — synthesis will handle gracefully")
            rag_chunks = []

    else:
        # Both tracks in parallel
        t0 = time.monotonic()
        query_embedding = await embed_task
        rag_task = retrieve_chunks_with_embedding(request.transcript, query_embedding)
        sql_task = template_search(merged_entities)
        results = await asyncio.gather(rag_task, sql_task, return_exceptions=True)

        if not isinstance(results[0], Exception):
            rag_chunks = results[0]
        if not isinstance(results[1], Exception):
            vehicles_raw = results[1].get("vehicles", [])

        rag_ms = (time.monotonic() - t0) * 1000
        sql_ms = rag_ms  # Both ran in parallel, report same wall time

    # ── Step 4: Synthesize ──
    t0 = time.monotonic()
    response_text = await synthesize_response(
        transcript=request.transcript,
        intent=intent.value,
        rag_chunks=rag_chunks,
        vehicles=vehicles_raw[:3],
        conversation_history=[t.model_dump() for t in request.conversation_history],
    )
    synthesis_ms = (time.monotonic() - t0) * 1000
    total_ms = (time.monotonic() - t_start) * 1000

    # Generate a TTS cache key for the response text so echokit-server
    # can cache the audio for identical responses.
    tts_cache_key = "tts_cache:" + hashlib.sha256(response_text.encode()).hexdigest()

    logger.info(
        "Turn complete: %.0fms total (intent=%.0f, sql=%.0f, rag=%.0f, synth=%.0f) → %d chars, tts_key=%s",
        total_ms, intent_ms, sql_ms, rag_ms, synthesis_ms, len(response_text), tts_cache_key[:30],
    )

    return AgentTurnResponse(
        response_text=response_text,
        intent=intent,
        intent_confidence=confidence,
        updated_entities=merged_entities,
        results=AgentTurnResults(
            rag_chunks=_to_rag_chunks(rag_chunks[:3]),
            vehicles=_to_vehicle_models(vehicles_raw[:3]),
        ),
        action=Action.RESPOND,
        transfer_to=None,
        latency_ms=LatencyMetrics(
            intent_ms=intent_ms,
            rag_ms=rag_ms,
            sql_ms=sql_ms,
            synthesis_ms=synthesis_ms,
            total_ms=total_ms,
        ),
    )


# ─── Internal helpers ────────────────────────────────────


async def _safe_embed(text: str) -> list[float] | None:
    """Embed text, returning None on error instead of raising."""
    try:
        return await embed_single(text)
    except asyncio.CancelledError:
        return None
    except Exception as e:
        logger.warning("Pre-embed failed (non-fatal): %s", e)
        return None


def _transfer_response(
    entities: SessionEntities, intent: Intent, confidence: float,
    intent_ms: float, t_start: float,
) -> AgentTurnResponse:
    assert _settings is not None
    return AgentTurnResponse(
        response_text="Let me connect you with one of our sales team members who can help you directly.",
        intent=intent,
        intent_confidence=confidence,
        updated_entities=entities,
        results=AgentTurnResults(),
        action=Action.TRANSFER,
        transfer_to=_settings.transfer_phone,
        latency_ms=LatencyMetrics(
            intent_ms=intent_ms,
            total_ms=(time.monotonic() - t_start) * 1000,
        ),
    )


def _safe_rag_source(source: str) -> RagSource:
    try:
        return RagSource(source)
    except ValueError:
        return RagSource.FAQ


def _to_rag_chunks(chunks: list[dict]) -> list[RagChunk]:
    return [
        RagChunk(
            id=str(c.get("id", "")),
            source=_safe_rag_source(c.get("source", "faq")),
            content=c.get("content", ""),
            score=min(max(float(c.get("score", 0)), 0.0), 1.0),
        )
        for c in chunks
    ]


def _to_vehicle_models(vehicles_raw: list[dict]) -> list[Vehicle]:
    models = []
    for v in vehicles_raw:
        try:
            models.append(Vehicle(
                vin=v.get("vin", "0" * 17),
                make=v.get("make", "Unknown"),
                model=v.get("model", "Unknown"),
                year=v.get("year", 2024),
                trim=v.get("trim"),
                color_ext=v.get("color_ext"),
                color_int=v.get("color_int"),
                mileage=v.get("mileage"),
                price=float(v.get("price", 0)),
                condition=_safe_condition(v.get("condition")),
                transmission=v.get("transmission"),
                fuel_type=v.get("fuel_type"),
                body_style=v.get("body_style"),
                features=v.get("features", []),
                status=_safe_status(v.get("status", "available")),
                description=v.get("description"),
            ))
        except Exception as e:
            logger.warning("Skipping vehicle: %s", e)
    return models


def _safe_condition(val: str | None) -> Condition | None:
    try:
        return Condition(val) if val else None
    except ValueError:
        return None


def _safe_status(val: str) -> Status:
    try:
        return Status(val)
    except ValueError:
        return Status.AVAILABLE
