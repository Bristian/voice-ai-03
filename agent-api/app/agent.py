"""Agent orchestrator — executes a full conversational turn.

Slice 4 Option A: unified single-LLM-call for non-vehicle intents.

For knowledge intents (hours, financing, policies, appointments, transfer):
  → ONE GPT-4o-mini call that classifies intent AND generates the response.
  → Knowledge base FAQ is embedded directly in the system prompt.
  → Saves one full LLM round-trip (~1000ms).

For vehicle intents (search, pricing, availability):
  → Still two calls: unified call returns intent+entities (response=null),
    then SQL lookup, then a SHORT synthesis call with vehicle data.
  → We can't merge these because the response depends on DB results.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import time

from app.config import Settings
from app.intent import merge_entities
from app.sql_agent import generate_and_execute, template_search
from app.synthesis import synthesize_response
from app.unified_turn import unified_classify_and_respond

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


def init_agent(settings: Settings) -> None:
    global _settings
    _settings = settings


async def process_turn(request: AgentTurnRequest) -> AgentTurnResponse:
    """Execute a full conversational turn."""
    assert _settings is not None
    t_start = time.monotonic()

    # ── Step 1: Unified classify + respond ──
    # One LLM call that returns intent, entities, AND response text.
    # For knowledge intents, response_text is the final answer (done in one call!).
    # For vehicle intents, response_text is None (needs SQL lookup first).
    t0 = time.monotonic()
    intent, confidence, new_entities, unified_response = await unified_classify_and_respond(
        request.transcript,
        request.session_entities,
        conversation_history=[t.model_dump() for t in request.conversation_history],
    )
    unified_ms = (time.monotonic() - t0) * 1000

    # Merge entities
    merged_entities = merge_entities(request.session_entities, new_entities)
    non_none_entities = {k: v for k, v in merged_entities.model_dump().items() if v is not None and v != []}
    logger.info(
        "Turn: intent=%s (%.2f), entities=%s, unified_response=%s",
        intent.value, confidence, non_none_entities,
        "yes" if unified_response else "no (needs vehicle lookup)",
    )

    # ── Step 2: Human transfer ──
    if intent == Intent.HUMAN_TRANSFER:
        response_text = unified_response or "Let me connect you with one of our sales team members who can help you directly."
        return _build_response(
            response_text=response_text,
            intent=intent, confidence=confidence,
            entities=merged_entities,
            action=Action.TRANSFER,
            transfer_to=_settings.transfer_phone,
            latency=LatencyMetrics(intent_ms=unified_ms, total_ms=(time.monotonic() - t_start) * 1000),
        )

    # ── Step 3: Knowledge intents — already answered! ──
    if unified_response and intent not in VEHICLE_INTENTS:
        total_ms = (time.monotonic() - t_start) * 1000
        logger.info(
            "Turn complete (unified): %.0fms total (single LLM call) → %d chars",
            total_ms, len(unified_response),
        )
        return _build_response(
            response_text=unified_response,
            intent=intent, confidence=confidence,
            entities=merged_entities,
            action=Action.RESPOND,
            latency=LatencyMetrics(intent_ms=unified_ms, synthesis_ms=0, total_ms=total_ms),
        )

    # ── Step 4: Vehicle intents — need SQL lookup + synthesis ──
    sql_ms = 0.0
    vehicles_raw: list[dict] = []

    t0 = time.monotonic()
    sql_result = await template_search(merged_entities)
    vehicles_raw = sql_result.get("vehicles", [])

    if not vehicles_raw and non_none_entities:
        logger.info("Template returned 0 results — trying LLM SQL generation")
        sql_result = await generate_and_execute(merged_entities)
        vehicles_raw = sql_result.get("vehicles", [])

    sql_ms = (time.monotonic() - t0) * 1000
    logger.info("SQL track: %d vehicles in %.0fms", len(vehicles_raw), sql_ms)

    # Synthesis with vehicle data
    t0 = time.monotonic()
    response_text = await synthesize_response(
        transcript=request.transcript,
        intent=intent.value,
        rag_chunks=[],
        vehicles=vehicles_raw[:3],
        conversation_history=[t.model_dump() for t in request.conversation_history],
    )
    synthesis_ms = (time.monotonic() - t0) * 1000
    total_ms = (time.monotonic() - t_start) * 1000

    logger.info(
        "Turn complete (vehicle): %.0fms total (unified=%.0f, sql=%.0f, synth=%.0f) → %d chars",
        total_ms, unified_ms, sql_ms, synthesis_ms, len(response_text),
    )

    return _build_response(
        response_text=response_text,
        intent=intent, confidence=confidence,
        entities=merged_entities,
        vehicles=vehicles_raw[:3],
        action=Action.RESPOND,
        latency=LatencyMetrics(
            intent_ms=unified_ms, sql_ms=sql_ms, synthesis_ms=synthesis_ms, total_ms=total_ms,
        ),
    )


# ─── Response builder ────────────────────────────────────


def _build_response(
    response_text: str,
    intent: Intent,
    confidence: float,
    entities: SessionEntities,
    action: Action = Action.RESPOND,
    transfer_to: str | None = None,
    vehicles: list[dict] | None = None,
    rag_chunks: list[dict] | None = None,
    latency: LatencyMetrics | None = None,
) -> AgentTurnResponse:
    return AgentTurnResponse(
        response_text=response_text,
        intent=intent,
        intent_confidence=confidence,
        updated_entities=entities,
        results=AgentTurnResults(
            rag_chunks=_to_rag_chunks(rag_chunks or []),
            vehicles=_to_vehicle_models(vehicles or []),
        ),
        action=action,
        transfer_to=transfer_to,
        latency_ms=latency or LatencyMetrics(),
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
