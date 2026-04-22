"""Agent orchestrator — executes a full conversational turn.

This is the brain. For every caller utterance it:
  1. Classifies intent + extracts entities (GPT-4o-mini)
  2. Runs RAG and/or SQL in parallel based on intent
  3. Synthesizes a voice-first response (GPT-4o)
  4. Decides action (respond / transfer / collect_lead)

The key architectural decision: RAG and SQL run in PARALLEL via
asyncio.gather. This saves ~200ms on the critical path for complex queries
where both tracks are needed.
"""

from __future__ import annotations

import asyncio
import logging
import time

from app.config import Settings
from app.intent import classify_intent, merge_entities
from app.rag import is_grounded, retrieve_chunks
from app.sql_agent import generate_and_execute
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

# Intents that should trigger the SQL track (vehicle search)
SQL_INTENTS = {Intent.VEHICLE_SEARCH, Intent.PRICING_QUERY, Intent.AVAILABILITY_CHECK}

# Intents that should trigger the RAG track (knowledge base)
RAG_INTENTS = {Intent.FINANCING_INQUIRY, Intent.DEALERSHIP_INFO, Intent.APPOINTMENT_REQUEST}

# Both tracks for ambiguous or compound queries
BOTH_INTENTS = SQL_INTENTS | RAG_INTENTS


def init_agent(settings: Settings) -> None:
    global _settings
    _settings = settings


async def process_turn(request: AgentTurnRequest) -> AgentTurnResponse:
    """Execute a full conversational turn. This is the POST /v1/agent/turn handler."""
    assert _settings is not None
    t_start = time.monotonic()

    # ── Step 1: Intent + entities ──
    t0 = time.monotonic()
    intent, confidence, new_entities = await classify_intent(
        request.transcript,
        request.session_entities,
    )
    intent_ms = (time.monotonic() - t0) * 1000

    # Merge new entities into session state
    merged_entities = merge_entities(request.session_entities, new_entities)

    logger.info(
        "Turn: intent=%s (%.2f), entities=%s",
        intent.value, confidence,
        {k: v for k, v in merged_entities.model_dump().items() if v is not None and v != []},
    )

    # ── Step 2: Handle human transfer immediately ──
    if intent == Intent.HUMAN_TRANSFER:
        return _transfer_response(
            merged_entities, intent, confidence, intent_ms, t_start
        )

    # ── Step 3: Parallel RAG + SQL ──
    rag_chunks: list[dict] = []
    sql_result: dict = {}
    rag_ms = 0.0
    sql_ms = 0.0

    tasks = []
    if intent in SQL_INTENTS or intent in BOTH_INTENTS:
        tasks.append(("sql", _timed_sql(merged_entities)))
    if intent in RAG_INTENTS or intent in BOTH_INTENTS:
        tasks.append(("rag", _timed_rag(request.transcript)))

    # If no specific track matched, default to RAG
    if not tasks:
        tasks.append(("rag", _timed_rag(request.transcript)))

    # Run in parallel
    results = await asyncio.gather(*(t[1] for t in tasks), return_exceptions=True)

    for (label, _), result in zip(tasks, results):
        if isinstance(result, Exception):
            logger.error("Track %s failed: %s", label, result)
            continue
        if label == "rag":
            rag_chunks, rag_ms = result
        elif label == "sql":
            sql_result, sql_ms = result

    vehicles_raw = sql_result.get("vehicles", []) if sql_result else []

    # ── Step 4: Hallucination guard ──
    # For RAG-only intents, check if we found grounded context
    if intent in RAG_INTENTS and not vehicles_raw:
        if rag_chunks and not is_grounded(rag_chunks):
            logger.warning("RAG hallucination guard triggered — transferring")
            return _transfer_response(
                merged_entities, intent, confidence, intent_ms, t_start
            )
        if not rag_chunks:
            logger.warning("No RAG chunks found — transferring")
            return _transfer_response(
                merged_entities, intent, confidence, intent_ms, t_start
            )

    # ── Step 5: Synthesize response ──
    t0 = time.monotonic()
    response_text = await synthesize_response(
        transcript=request.transcript,
        intent=intent.value,
        rag_chunks=rag_chunks,
        vehicles=vehicles_raw[:3],  # Max 3 per response
        conversation_history=[t.model_dump() for t in request.conversation_history],
    )
    synthesis_ms = (time.monotonic() - t0) * 1000
    total_ms = (time.monotonic() - t_start) * 1000

    # ── Build response ──
    rag_chunk_models = [
        RagChunk(
            id=str(c.get("id", "")),
            source=_safe_rag_source(c.get("source", "faq")),
            content=c.get("content", ""),
            score=min(max(float(c.get("score", 0)), 0.0), 1.0),
        )
        for c in rag_chunks[:3]
    ]

    vehicle_models = _raw_to_vehicle_models(vehicles_raw[:3])

    return AgentTurnResponse(
        response_text=response_text,
        intent=intent,
        intent_confidence=confidence,
        updated_entities=merged_entities,
        results=AgentTurnResults(
            rag_chunks=rag_chunk_models,
            vehicles=vehicle_models,
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


# ─── Helpers ──────────────────────────────────────────────


async def _timed_rag(query: str) -> tuple[list[dict], float]:
    t0 = time.monotonic()
    chunks = await retrieve_chunks(query)
    ms = (time.monotonic() - t0) * 1000
    return chunks, ms


async def _timed_sql(entities: SessionEntities) -> tuple[dict, float]:
    t0 = time.monotonic()
    result = await generate_and_execute(entities)
    ms = (time.monotonic() - t0) * 1000
    return result, ms


def _transfer_response(
    entities: SessionEntities,
    intent: Intent,
    confidence: float,
    intent_ms: float,
    t_start: float,
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


def _raw_to_vehicle_models(vehicles_raw: list[dict]) -> list[Vehicle]:
    """Convert raw dicts to Vehicle contract models, handling missing fields."""
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
            logger.warning("Skipping vehicle due to validation error: %s", e)
    return models


def _safe_condition(val: str | None) -> Condition | None:
    if val is None:
        return None
    try:
        return Condition(val)
    except ValueError:
        return None


def _safe_status(val: str) -> Status:
    try:
        return Status(val)
    except ValueError:
        return Status.AVAILABLE
