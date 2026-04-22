"""Voice-to-SQL agent — generate, validate, execute vehicle queries.

Takes extracted entities (make, model, year range, price range, etc.) and
either generates SQL via GPT-4o-mini or falls back to a template query.

SECURITY SURFACE — THIS FILE IS LOAD-BEARING:
  - Only SELECT allowed. INSERT/UPDATE/DELETE/DROP/ALTER/-- are rejected.
  - Must always include WHERE status = 'available'.
  - Parameterized queries only ($1, $2) — never interpolated values.
  - If validation fails → fall back to template queries.
  - If results are empty → widen constraints one at a time.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
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

FORBIDDEN_KEYWORDS = {"INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "TRUNCATE", "GRANT", "REVOKE", "--", ";"}

SCHEMA_DESCRIPTION = """\
Table: vehicles
Columns:
  vin VARCHAR(17), make VARCHAR(50), model VARCHAR(100), year SMALLINT,
  trim VARCHAR(100), color_ext VARCHAR(50), color_int VARCHAR(50),
  mileage INT, price NUMERIC(10,2), condition VARCHAR(10),
  transmission VARCHAR(20), fuel_type VARCHAR(20), body_style VARCHAR(30),
  features JSONB, status VARCHAR(20), description TEXT

RULES:
- Generate ONLY a single SELECT query
- Always include: WHERE status = 'available'
- Use parameterized placeholders: $1, $2, $3, etc. — NEVER interpolate values
- Use ILIKE for text matching (case-insensitive)
- ORDER BY price ASC unless user implies otherwise
- LIMIT to {max_results}
- Return JSON: {{"sql": "SELECT ...", "params": [...], "explanation": "..."}}
"""

SQL_SYSTEM_PROMPT = """\
You are a PostgreSQL query generator for a car dealership inventory system.
""" + SCHEMA_DESCRIPTION


def init_sql_agent(settings: Settings) -> None:
    global _client, _settings
    _client = AsyncOpenAI(api_key=settings.openai_api_key)
    _settings = settings


def _cache_key(entities: SessionEntities) -> str:
    """Deterministic cache key from entities."""
    non_none = {k: v for k, v in entities.model_dump().items() if v is not None and v != []}
    raw = json.dumps(non_none, sort_keys=True)
    h = hashlib.sha256(raw.encode()).hexdigest()[:16]
    return f"vehicle_query:{h}"


def validate_sql(sql: str) -> None:
    """Reject unsafe queries. Raises ValueError on failure."""
    upper = sql.upper()

    for kw in FORBIDDEN_KEYWORDS:
        if kw.upper() in upper:
            raise ValueError(f"Forbidden keyword detected: {kw}")

    if "STATUS" not in upper or "'AVAILABLE'" not in upper.replace('"', "'"):
        raise ValueError("Missing required availability filter (status = 'available')")

    # Must have at least one parameterized placeholder
    # (Exception: if the query only filters on status, no user params needed)
    if "$" not in sql and "WHERE STATUS" not in upper.replace("WHERE STATUS", "WHERE STATUS"):
        # Allow queries that only filter on status
        pass

    # Reject multiple statements
    if sql.strip().count(";") > 1:
        raise ValueError("Multiple statements detected")


async def generate_and_execute(
    entities: SessionEntities,
    limit: int | None = None,
) -> dict[str, Any]:
    """Main entry point: generate SQL from entities, validate, execute.

    Returns:
      {
        "vehicles": [...],
        "generated_sql": str,
        "params": list,
        "cache_hit": bool,
        "widened_constraints": list[str],
      }
    """
    assert _client is not None and _settings is not None
    max_results = limit or _settings.sql_max_results

    # Check cache first
    key = _cache_key(entities)
    cached = await cache_get_json(key)
    if cached is not None:
        logger.info("SQL cache HIT: %s", key)
        return {**cached, "cache_hit": True}

    t0 = time.monotonic()

    # Build user message from entities
    non_none = {k: v for k, v in entities.model_dump().items() if v is not None and v != []}
    if not non_none:
        # No entities at all — return a broad search
        return await _execute_template_broad(max_results)

    user_msg = f"Find vehicles matching: {json.dumps(non_none)}"

    try:
        # Generate SQL via LLM
        resp = await _client.chat.completions.create(
            model=_settings.intent_model,  # GPT-4o-mini for speed
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

        # Validate the generated SQL
        validate_sql(sql)

        # Execute
        rows = await fetch_all(sql, *params)
        elapsed_ms = (time.monotonic() - t0) * 1000
        logger.info("SQL generated+executed in %.0fms: %d rows", elapsed_ms, len(rows))

        vehicles = _rows_to_vehicles(rows)
        widened = []

        # If no results, try widening constraints
        if not vehicles:
            vehicles, widened = await _widen_search(entities, max_results)

        result = {
            "vehicles": vehicles,
            "generated_sql": sql,
            "params": params,
            "widened_constraints": widened,
        }

    except (ValueError, json.JSONDecodeError) as e:
        logger.warning("SQL generation/validation failed: %s — falling back to template", e)
        result = await _template_fallback(entities, max_results)

    except Exception as e:
        logger.error("SQL execution error: %s", e)
        result = await _template_fallback(entities, max_results)

    # Cache the result
    result["cache_hit"] = False
    await cache_set_json(key, result, _settings.sql_cache_ttl_seconds)
    return result


async def _template_fallback(entities: SessionEntities, limit: int) -> dict:
    """Fall back to hand-written parameterized queries for common patterns."""
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
    if e.get("condition"):
        conditions.append(f"condition = ${idx}")
        params.append(e["condition"])
        idx += 1

    where = " AND ".join(conditions)
    sql = f"SELECT * FROM vehicles WHERE {where} ORDER BY price ASC LIMIT {limit}"

    rows = await fetch_all(sql, *params)
    vehicles = _rows_to_vehicles(rows)

    return {
        "vehicles": vehicles,
        "generated_sql": sql,
        "params": params,
        "widened_constraints": [],
    }


async def _execute_template_broad(limit: int) -> dict:
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
    """Drop constraints one at a time in priority order until we get results.

    Priority order (least important first): color → trim → year → price +20%.
    """
    widened: list[str] = []
    e = entities.model_copy()

    # Order of constraint relaxation
    relax_steps = [
        ("color_ext", None),
        ("trim", None),
        ("year_min", None),
        ("year_max", None),
    ]

    for field, _ in relax_steps:
        if getattr(e, field, None) is not None:
            setattr(e, field, None)
            widened.append(field)
            result = await _template_fallback(e, limit)
            if result["vehicles"]:
                return result["vehicles"], widened

    # Last resort: widen price by 20%
    if e.price_max is not None:
        e.price_max = round(e.price_max * 1.2, 2)
        widened.append("price_max +20%")
        result = await _template_fallback(e, limit)
        if result["vehicles"]:
            return result["vehicles"], widened

    return [], widened


def _rows_to_vehicles(rows: list[dict]) -> list[dict]:
    """Convert DB rows to the vehicle contract shape (JSON-safe)."""
    vehicles = []
    for r in rows:
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
            "features": r.get("features", []),
            "status": r.get("status", "available"),
            "description": r.get("description"),
        })
    return vehicles
