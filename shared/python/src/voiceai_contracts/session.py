"""Session — per-call working memory.

Mirrors shared/contracts/session.schema.json.
Stored in Redis as JSON under key `session:{call_uuid}` with TTL 2h.
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


Role = Literal["user", "assistant"]


class Intent(str, Enum):
    VEHICLE_SEARCH = "vehicle_search"
    PRICING_QUERY = "pricing_query"
    AVAILABILITY_CHECK = "availability_check"
    FINANCING_INQUIRY = "financing_inquiry"
    DEALERSHIP_INFO = "dealership_info"
    APPOINTMENT_REQUEST = "appointment_request"
    HUMAN_TRANSFER = "human_transfer"


class SessionEntities(BaseModel):
    """Merged entities across conversation turns. Enables multi-turn refinement."""

    model_config = ConfigDict(extra="forbid")

    make: str | None = None
    model: str | None = None
    year_min: int | None = Field(default=None, ge=1900, le=2100)
    year_max: int | None = Field(default=None, ge=1900, le=2100)
    trim: str | None = None
    color_ext: str | None = None
    color_int: str | None = None
    body_style: str | None = None
    transmission: str | None = None
    fuel_type: str | None = None
    price_min: float | None = Field(default=None, ge=0)
    price_max: float | None = Field(default=None, ge=0)
    mileage_max: int | None = Field(default=None, ge=0)
    features: list[str] = Field(default_factory=list)
    condition: Literal["new", "used", "cpo"] | None = None


class ConversationTurn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: Role
    text: str
    ts: datetime
    confidence: float | None = Field(default=None, ge=0.0, le=1.0)


class Session(BaseModel):
    """Per-call working memory stored in Redis."""

    model_config = ConfigDict(extra="forbid")

    call_uuid: str = Field(min_length=1)
    vonage_conversation_uuid: str | None = None
    caller_phone_hash: str = Field(min_length=64, max_length=64)
    caller_phone_last4: str | None = Field(default=None, pattern=r"^[0-9]{4}$")
    started_at: datetime
    ended_at: datetime | None = None
    entities: SessionEntities = Field(default_factory=SessionEntities)
    conversation_history: list[ConversationTurn] = Field(default_factory=list)
    tts_playing: bool = False
    intent: Intent | None = None
    transfer_attempts: int = Field(default=0, ge=0)
