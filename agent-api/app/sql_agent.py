"""Voice-to-SQL agent — generate, validate, execute vehicle queries.

Slice 3 improvements:
  - template_search() is now the primary path — fast, no LLM call.
  - generate_and_execute() uses the LLM only as a fallback for complex queries.
  - Validator is more robust (handles trailing semicolons, better logging).
  - Widening logic improved (tries body_style variations too).

SECURITY SURFACE — THIS FILE IS LOAD-BEARING:
  - Only SELECT allowed. INSERT/UPDATE/DELETE/DROP/ALTER rejected.
  - Must always include WHERE status = 'available'.
  - Parameterized queries only ($1, $2) — never interpolated values.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
from typing import Any

from openai import AsyncOpenAI

from app.config import Settings
from app.db import fetch_all
from app.redis_client import cache_get_json, cache_set_json

from voiceai_contracts.session import SessionEntities

logger = logging.getLogger("agent-api.sql_agent")

_client: AsyncOpenAI | None = None
_settings: Settings | None = None

FORBIDDEN_KEYWORDS = {"INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "TRUNCATE", "GRANT", "REVOKE"}


SCHEMA_DESCRIPTION = """\
Table: vehicles
Columns:
  vin VARCHAR(17), make VARCHAR(50), model VARCHAR(100), year SMALLINT,
  trim VARCHAR(100), color_ext VARCHAR(50), color_int VARCHAR(50),
  mileage INT, price NUMERIC(10,2), condition VARCHAR(10),
  transmission VARCHAR(20), fuel_type VARCHAR(20), body_style VARCHAR(30),
  features JSONB, status VARCHAR(20), description TEXT

RULES:
- Generate ONLY a single SELECT query. No semicolons.
- Always include: WHERE status = 'available'
- Use parameterized placeholders: $1, $2, $3 — NEVER interpolate values
- Use ILIKE for text matching (case-insensitive)
- ORDER BY price ASC
- LIMIT {max_results}
- Return JSON: {{"sql": "SELECT ...", "params": [...], "explanation": "..."}}
"""

SQL_SYSTEM_PROMPT = (
    "You are a PostgreSQL query generator for a car dealership inventory system.\n"
    + SCHEMA_DESCRIPTION
)


def init_sql_agent(settings: Settings) -> None:
    global _client, _settings
    _client = AsyncOpenAI(api_key=settings.openai_api_key)
    _settings = settings


def _cache_key(entities: SessionEntities) -> str:
    non_none = {k: v for k, v in entities.model_dump().items() if v is not None and v != []}
    raw = json.dumps(non_none, sort_keys=True)
    h = hashlib.sha256(raw.encode()).hexdigest()[:16]
    return f"vehicle_query:{h}"


def validate_sql(sql: str) -> None:
    """Reject unsafe queries. Raises ValueError on failure."""
    # Strip trailing whitespace and semicolons (LLMs often add one)
    cleaned = sql.strip().rstrip(";").strip()
    upper = cleaned.upper()

    for kw in FORBIDDEN_KEYWORDS:
        if kw in upper:
            raise ValueError(f"Forbidden keyword detected: {kw}")

    # Check for SQL comments
    if "--" in cleaned or "/*" in cleaned:
        raise ValueError("SQL comments not allowed")

    if "STATUS" not in upper or "'AVAILABLE'" not in upper.replace('"', "'"):
        raise ValueError("Missing required availability filter (status = 'available')")

    # Reject multiple statements (after stripping the trailing semicolon)
    if ";" in cleaned:
        raise ValueError("Multiple statements detected")


# ─── PUBLIC API ──────────────────────────────────────────


async def template_search(
    entities: SessionEntities,
    limit: int | None = None,
) -> dict[str, Any]:
    """Fast template-based search. No LLM call — just builds WHERE clause from entities.

    This is the PRIMARY search path for vehicle queries. It's fast (~10ms for
    cache hit, ~50ms for DB query) and reliable.
    """
    assert _settings is not None
    max_results = limit or _settings.sql_max_results

    # Check cache
    key = _cache_key(entities)
    cached = await cache_get_json(key)
    if cached is not None:
        logger.info("SQL template cache HIT: %s", key)
        return {**cached, "cache_hit": True}

    t0 = time.monotonic()

    non_none = {k: v for k, v in entities.model_dump().items() if v is not None and v != []}
    if not non_none:
        return await _broad_search(max_results)

    result = await _build_and_execute_template(entities, max_results)

    # If no results, try widening
    if not result["vehicles"]:
        vehicles, widened = await _widen_search(entities, max_results)
        result["vehicles"] = vehicles
        result["widened_constraints"] = widened

    elapsed_ms = (time.monotonic() - t0) * 1000
    logger.info("Template search: %d vehicles in %.0fms", len(result["vehicles"]), elapsed_ms)

    # Cache
    result["cache_hit"] = False
    await cache_set_json(key, result, _settings.sql_cache_ttl_seconds)
    return result


async def generate_and_execute(
    entities: SessionEntities,
    limit: int | None = None,
) -> dict[str, Any]:
    """LLM-generated SQL — used as fallback when template_search returns 0 results.

    Slower (~200-400ms for LLM call) but handles complex natural language queries
    the template can't express (e.g., "something sporty but practical").
    """
    assert _client is not None and _settings is not None
    max_results = limit or _settings.sql_max_results

    t0 = time.monotonic()
    non_none = {k: v for k, v in entities.model_dump().items() if v is not None and v != []}
    user_msg = f"Find vehicles matching: {json.dumps(non_none)}"

    try:
        resp = await _client.chat.completions.create(
            model=_settings.intent_model,
            messages=[
                {"role": "system", "content": SQL_SYSTEM_PROMPT.format(max_results=max_results)},
                {"role": "user", "content": user_msg},
            ],
            temperature=0.0,
            max_tokens=400,
            response_format={"type": "json_object"},
        )
        raw = resp.choices[0].message.content or "{}"
        parsed = json.loads(raw)
        sql = parsed.get("sql", "")
        params = parsed.get("params", [])

        # Strip trailing semicolon before validation
        sql = sql.strip().rstrip(";").strip()

        validate_sql(sql)

        rows = await fetch_all(sql, *params)
        elapsed_ms = (time.monotonic() - t0) * 1000
        logger.info("LLM SQL in %.0fms: %d rows. SQL: %s", elapsed_ms, len(rows), sql[:200])

        vehicles = _rows_to_vehicles(rows)
        return {
            "vehicles": vehicles,
            "generated_sql": sql,
            "params": params,
            "cache_hit": False,
            "widened_constraints": [],
        }

    except Exception as e:
        logger.warning("LLM SQL failed: %s — returning empty", e)
        return {
            "vehicles": [],
            "generated_sql": "",
            "params": [],
            "cache_hit": False,
            "widened_constraints": [],
        }


# ─── INTERNAL ────────────────────────────────────────────


async def _build_and_execute_template(entities: SessionEntities, limit: int) -> dict:
    """Build parameterized SQL from entities and execute."""
    conditions = ["status = 'available'"]
    params: list[Any] = []
    idx = 1

    e = entities.model_dump()

    if e.get("make"):
        conditions.append(f"make ILIKE ${idx}")
        params.append(f"%{e['make']}%")
        idx += 1
    if e.get("model"):
        conditions.append(f"model ILIKE ${idx}")
        params.append(f"%{e['model']}%")
        idx += 1
    if e.get("body_style"):
        conditions.append(f"body_style ILIKE ${idx}")
        params.append(f"%{e['body_style']}%")
        idx += 1
    if e.get("color_ext"):
        conditions.append(f"color_ext ILIKE ${idx}")
        params.append(f"%{e['color_ext']}%")
        idx += 1
    if e.get("year_min"):
        conditions.append(f"year >= ${idx}")
        params.append(e["year_min"])
        idx += 1
    if e.get("year_max"):
        conditions.append(f"year <= ${idx}")
        params.append(e["year_max"])
        idx += 1
    if e.get("price_max"):
        conditions.append(f"price <= ${idx}")
        params.append(e["price_max"])
        idx += 1
    if e.get("price_min"):
        conditions.append(f"price >= ${idx}")
        params.append(e["price_min"])
        idx += 1
    if e.get("fuel_type"):
        conditions.append(f"fuel_type ILIKE ${idx}")
        params.append(f"%{e['fuel_type']}%")
        idx += 1
    if e.get("transmission"):
        conditions.append(f"transmission ILIKE ${idx}")
        params.append(f"%{e['transmission']}%")
        idx += 1
    if e.get("condition"):
        conditions.append(f"condition = ${idx}")
        params.append(e["condition"])
        idx += 1
    if e.get("mileage_max"):
        conditions.append(f"mileage <= ${idx}")
        params.append(e["mileage_max"])
        idx += 1

    where = " AND ".join(conditions)
    sql = f"SELECT * FROM vehicles WHERE {where} ORDER BY price ASC LIMIT {limit}"

    logger.debug("Template SQL: %s | params: %s", sql, params)
    rows = await fetch_all(sql, *params)

    return {
        "vehicles": _rows_to_vehicles(rows),
        "generated_sql": sql,
        "params": params,
        "widened_constraints": [],
    }


async def _broad_search(limit: int) -> dict:
    """No entities — return newest available vehicles."""
    sql = f"SELECT * FROM vehicles WHERE status = 'available' ORDER BY created_at DESC LIMIT {limit}"
    rows = await fetch_all(sql)
    return {
        "vehicles": _rows_to_vehicles(rows),
        "generated_sql": sql,
        "params": [],
        "cache_hit": False,
        "widened_constraints": [],
    }


async def _widen_search(entities: SessionEntities, limit: int) -> tuple[list[dict], list[str]]:
    """Drop constraints one at a time until we get results."""
    widened: list[str] = []
    e = entities.model_copy()

    # Order: least important first
    for field in ["color_ext", "color_int", "trim", "transmission", "year_min", "year_max"]:
        if getattr(e, field, None) is not None:
            setattr(e, field, None)
            widened.append(field)
            result = await _build_and_execute_template(e, limit)
            if result["vehicles"]:
                return result["vehicles"], widened

    # Widen price by 30%
    if e.price_max is not None:
        e.price_max = round(e.price_max * 1.3, 2)
        widened.append("price_max +30%")
        result = await _build_and_execute_template(e, limit)
        if result["vehicles"]:
            return result["vehicles"], widened

    # Widen mileage
    if e.mileage_max is not None:
        e.mileage_max = None
        widened.append("mileage_max removed")
        result = await _build_and_execute_template(e, limit)
        if result["vehicles"]:
            return result["vehicles"], widened

    # Last resort: drop body_style (maybe "SUV" vs "suv" didn't match)
    if e.body_style is not None:
        e.body_style = None
        widened.append("body_style")
        result = await _build_and_execute_template(e, limit)
        if result["vehicles"]:
            return result["vehicles"], widened

    return [], widened


def _rows_to_vehicles(rows: list[dict]) -> list[dict]:
    """Convert DB rows to JSON-safe vehicle dicts."""
    vehicles = []
    for r in rows:
        # Handle features: JSONB can come back as a string or a list depending
        # on asyncpg version and connection settings
        features = r.get("features", [])
        if isinstance(features, str):
            try:
                import json as _json
                features = _json.loads(features)
            except (ValueError, TypeError):
                features = []
        if not isinstance(features, list):
            features = []

        vehicles.append({
            "vin": r.get("vin", ""),
            "make": r.get("make", ""),
            "model": r.get("model", ""),
            "year": r.get("year", 0),
            "trim": r.get("trim"),
            "color_ext": r.get("color_ext"),
            "color_int": r.get("color_int"),
            "mileage": r.get("mileage"),
            "price": float(r.get("price", 0)),
            "condition": r.get("condition"),
            "transmission": r.get("transmission"),
            "fuel_type": r.get("fuel_type"),
            "body_style": r.get("body_style"),
            "features": features,
            "status": r.get("status", "available"),
            "description": r.get("description"),
        })
    return vehicles
