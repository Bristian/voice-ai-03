"""Unified turn — single LLM call that does intent + entity extraction + response.

For non-vehicle intents (hours, financing, policies, appointments, transfer),
we can classify intent AND generate the response in a single GPT-4o-mini call.
This saves one full LLM round-trip (~1000ms).

For vehicle intents, the caller still uses the two-step pipeline (intent → SQL → synthesis)
because the response depends on database results the LLM doesn't have at call time.

The trick: we embed the knowledge base FAQ content directly in the system prompt
so the LLM has everything it needs to answer in one shot. The FAQ corpus is small
enough (~3KB) to fit comfortably in the context window.
"""

from __future__ import annotations

import json
import logging
import time
from typing import Sequence

from openai import AsyncOpenAI

from app.config import Settings
from voiceai_contracts.session import Intent, SessionEntities

logger = logging.getLogger("agent-api.unified")

_client: AsyncOpenAI | None = None
_settings: Settings | None = None

# Pre-loaded knowledge base content, injected at startup
_knowledge_base: str = ""


def init_unified(settings: Settings, knowledge_chunks: Sequence[dict] | None = None) -> None:
    global _client, _settings, _knowledge_base
    _client = AsyncOpenAI(api_key=settings.openai_api_key)
    _settings = settings

    if knowledge_chunks:
        _knowledge_base = _format_knowledge(knowledge_chunks)
        logger.info(
            "Unified turn loaded %d knowledge chunks (%d chars)",
            len(knowledge_chunks), len(_knowledge_base),
        )


def _format_knowledge(chunks: Sequence[dict]) -> str:
    """Format knowledge chunks into a compact reference for the system prompt.

    Truncates each chunk to ~150 chars to keep the total prompt small.
    A smaller prompt = faster GPT-4o-mini response time.
    """
    sections: dict[str, list[str]] = {}
    for c in chunks:
        source = c.get("source", "general")
        content = c.get("content", "")
        if content:
            # Truncate to first ~150 chars at a sentence boundary
            truncated = content[:200]
            dot_pos = truncated.rfind(". ")
            if dot_pos > 80:
                truncated = truncated[:dot_pos + 1]
            sections.setdefault(source.upper(), []).append(truncated)

    parts = []
    for source, items in sections.items():
        parts.append(f"[{source}]")
        for item in items:
            parts.append(f"  • {item}")
    return "\n".join(parts)


SYSTEM_PROMPT = """\
You are a car dealership phone assistant. You must do TWO things in one response:

1. CLASSIFY the caller's intent and extract any vehicle-related entities
2. GENERATE a spoken response (if the intent is NOT a vehicle search)

INTENTS:
- vehicle_search: wants to find/browse/compare/narrow vehicles, price refinements on vehicles
- pricing_query: asking about price of a SPECIFIC vehicle
- availability_check: "do you have X in stock?"
- financing_inquiry: loans, APR, payments, leasing
- dealership_info: hours, location, contact, test drives, trade-ins, return policy, warranty
- appointment_request: schedule a visit or test drive
- human_transfer: EXPLICITLY asks for a person/agent/manager

ENTITY EXTRACTION (only for vehicle-related intents):
Extract any mentioned: make, model, year_min, year_max, trim, color_ext, body_style,
transmission, fuel_type, price_min, price_max, mileage_max, features[], condition

IMPORTANT RULES:
- If prior entities contain vehicle fields AND the utterance refines that search,
  classify as vehicle_search.
- For vehicle_search/pricing_query/availability_check: set response to null
  (the system will look up vehicles and generate a response separately).
- For ALL OTHER intents: generate a warm, concise spoken response (1-2 sentences,
  under 40 words, no markdown, end with a follow-up question).
- Use the KNOWLEDGE BASE below to answer dealership_info, financing, and appointment questions.
- If the knowledge base doesn't cover the question, say "Let me get someone who can help with that."

KNOWLEDGE BASE:
{knowledge_base}

Respond with ONLY a JSON object:
{{
  "intent": "<intent>",
  "confidence": <0.0-1.0>,
  "entities": {{ ... }},
  "response": "<spoken response or null for vehicle intents>"
}}
"""


async def unified_classify_and_respond(
    transcript: str,
    prior_entities: SessionEntities | None = None,
    conversation_history: list[dict] | None = None,
) -> tuple[Intent, float, SessionEntities, str | None]:
    """Single LLM call that classifies intent AND generates response for knowledge intents.

    Returns (intent, confidence, new_entities, response_text_or_none).
    response_text is None for vehicle intents (need SQL lookup first).
    """
    assert _client is not None and _settings is not None

    # Build system prompt with embedded knowledge base
    system = SYSTEM_PROMPT.format(knowledge_base=_knowledge_base or "(no knowledge base loaded)")

    # Build user message
    user_msg = f'Caller said: "{transcript}"'
    if prior_entities:
        non_none = {k: v for k, v in prior_entities.model_dump().items() if v is not None and v != []}
        if non_none:
            user_msg += f"\nPrior entities from conversation: {json.dumps(non_none)}"

    # Add conversation history for context
    messages: list[dict] = [{"role": "system", "content": system}]
    if conversation_history:
        for turn in conversation_history[-4:]:
            role = turn.get("role", "user")
            messages.append({"role": role, "content": turn.get("text", "")})
    messages.append({"role": "user", "content": user_msg})

    t0 = time.monotonic()
    resp = await _client.chat.completions.create(
        model=_settings.intent_model,  # GPT-4o-mini for speed
        messages=messages,
        temperature=0.3,
        max_tokens=250,
        response_format={"type": "json_object"},
    )
    elapsed_ms = (time.monotonic() - t0) * 1000

    raw = resp.choices[0].message.content or "{}"
    logger.info("Unified call in %.0fms: %s", elapsed_ms, raw[:200])

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("Failed to parse unified JSON: %s", raw[:200])
        return Intent.DEALERSHIP_INFO, 0.5, SessionEntities(), None

    # Parse intent
    intent_str = parsed.get("intent", "dealership_info")
    try:
        intent = Intent(intent_str)
    except ValueError:
        intent = Intent.DEALERSHIP_INFO

    confidence = float(parsed.get("confidence", 0.5))

    # Parse entities
    raw_entities = parsed.get("entities", {})
    valid_fields = set(SessionEntities.model_fields.keys())
    filtered = {k: v for k, v in raw_entities.items() if k in valid_fields and v is not None}
    entities = SessionEntities(**filtered)

    # Parse response (None for vehicle intents)
    response_text = parsed.get("response")
    if isinstance(response_text, str) and response_text.strip().lower() in ("null", "none", ""):
        response_text = None

    return intent, confidence, entities, response_text
