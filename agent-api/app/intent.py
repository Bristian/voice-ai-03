"""Intent classification + entity extraction — GPT-4o-mini.

Takes a raw transcript and returns:
  - intent (one of the 7 canonical intents)
  - confidence (0-1)
  - extracted entities (make, model, year, price range, etc.)

Uses GPT-4o-mini for speed (~80-150ms). Results are NOT cached per-turn
because caller utterances are almost never identical, but the session's
accumulated entities ARE carried forward across turns.
"""

from __future__ import annotations

import json
import logging
import time

from openai import AsyncOpenAI

from app.config import Settings
from voiceai_contracts.session import Intent, SessionEntities

logger = logging.getLogger("agent-api.intent")

_client: AsyncOpenAI | None = None
_settings: Settings | None = None

SYSTEM_PROMPT = """\
You are a car dealership AI intent classifier. Given the caller's latest utterance
and any prior extracted entities from the conversation, classify the intent and
extract any new entities.

IMPORTANT RULES:
- If prior entities contain vehicle-related fields (make, model, body_style, price_max, etc.)
  AND the new utterance refines or narrows that search (e.g. "something cheaper",
  "make it blue", "under thirty thousand", "what about a hybrid"), classify as
  vehicle_search — NOT as pricing_query or other intents.
- Only classify as human_transfer if the caller EXPLICITLY says they want a person,
  agent, representative, or manager.
- When in doubt between vehicle_search and pricing_query, choose vehicle_search.

INTENTS (pick exactly one):
- vehicle_search: caller wants to find, browse, compare, or narrow down vehicles.
  Also use this for price-related questions in the context of searching for vehicles.
- pricing_query: asking about the price of a SPECIFIC vehicle they already know about
- availability_check: "do you have X in stock?"
- financing_inquiry: asking about loans, APR, monthly payments, leasing
- dealership_info: asking about hours, location, contact, test drives, trade-ins
- appointment_request: wants to schedule a visit or test drive
- human_transfer: EXPLICITLY asks for a person / agent / manager

ENTITIES to extract (only include fields mentioned or clearly implied):
- make (string): manufacturer, e.g. "Toyota"
- model (string): model name, e.g. "Camry"
- year_min / year_max (int): year or year range
- trim (string): trim level
- color_ext (string): exterior color
- body_style (string): "SUV", "Sedan", "Truck", "Coupe", etc.
- transmission (string): "Automatic", "Manual"
- fuel_type (string): "Gasoline", "Hybrid", "Electric", "Diesel"
- price_min / price_max (number): dollar amounts
- mileage_max (int): maximum mileage
- features (string[]): specific features like "AWD", "Sunroof"
- condition (string): "new", "used", "cpo"

Respond with ONLY a JSON object (no markdown, no explanation):
{
  "intent": "<intent_string>",
  "confidence": <0.0-1.0>,
  "entities": { ... only fields that were mentioned ... }
}
"""


def init_intent(settings: Settings) -> None:
    global _client, _settings
    _client = AsyncOpenAI(api_key=settings.openai_api_key)
    _settings = settings


async def classify_intent(
    transcript: str,
    prior_entities: SessionEntities | None = None,
) -> tuple[Intent, float, SessionEntities]:
    """Classify intent and extract entities from a transcript.

    Returns (intent, confidence, new_entities).
    The caller is responsible for merging new_entities into the session.
    """
    assert _client is not None and _settings is not None

    user_msg = f"Transcript: \"{transcript}\""
    if prior_entities:
        non_none = {k: v for k, v in prior_entities.model_dump().items() if v is not None and v != []}
        if non_none:
            user_msg += f"\nPrior entities: {json.dumps(non_none)}"

    t0 = time.monotonic()
    resp = await _client.chat.completions.create(
        model=_settings.intent_model,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_msg},
        ],
        temperature=0.1,
        max_tokens=300,
        response_format={"type": "json_object"},
    )
    elapsed_ms = (time.monotonic() - t0) * 1000

    raw = resp.choices[0].message.content or "{}"
    logger.info("Intent classified in %.0fms: %s", elapsed_ms, raw[:200])

    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        logger.warning("Failed to parse intent JSON: %s", raw[:200])
        return Intent.DEALERSHIP_INFO, 0.5, SessionEntities()

    # Map to our Intent enum
    intent_str = parsed.get("intent", "dealership_info")
    try:
        intent = Intent(intent_str)
    except ValueError:
        logger.warning("Unknown intent '%s', defaulting to dealership_info", intent_str)
        intent = Intent.DEALERSHIP_INFO

    confidence = float(parsed.get("confidence", 0.5))

    # Parse entities
    raw_entities = parsed.get("entities", {})
    # Filter to only fields SessionEntities accepts
    valid_fields = set(SessionEntities.model_fields.keys())
    filtered = {k: v for k, v in raw_entities.items() if k in valid_fields and v is not None}
    entities = SessionEntities(**filtered)

    return intent, confidence, entities


def merge_entities(existing: SessionEntities, new: SessionEntities) -> SessionEntities:
    """Merge new entities into existing, with new values overriding old.

    This enables multi-turn refinement: "I want an SUV" → "make it blue" → merged.
    """
    merged = existing.model_dump()
    for key, value in new.model_dump().items():
        if value is not None and value != []:
            if key == "features" and isinstance(value, list):
                # Append new features to existing list, dedup
                existing_features = merged.get("features", []) or []
                merged["features"] = list(set(existing_features + value))
            else:
                merged[key] = value
    return SessionEntities(**merged)
