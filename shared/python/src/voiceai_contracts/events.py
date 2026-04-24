"""Event payloads — Vonage webhooks + supervisor dashboard WS events.

Mirrors shared/contracts/webhook-events.schema.json and ws-events.schema.json.
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from voiceai_contracts.session import SessionEntities
from voiceai_contracts.vehicle import Vehicle


# ─── Vonage webhook payloads ───


class EventStatus(str, Enum):
    STARTED = "started"
    RINGING = "ringing"
    ANSWERED = "answered"
    BUSY = "busy"
    CANCELLED = "cancelled"
    FAILED = "failed"
    REJECTED = "rejected"
    TIMEOUT = "timeout"
    UNANSWERED = "unanswered"
    COMPLETED = "completed"
    MACHINE = "machine"
    HUMAN = "human"


class AnswerWebhookRequest(BaseModel):
    """POST /webhooks/answer — Vonage calls this when call arrives."""

    model_config = ConfigDict(extra="allow")

    uuid: str
    conversation_uuid: str | None = None
    from_: str = Field(alias="from")
    to: str
    region_url: str | None = None
    custom_data: dict[str, Any] | None = None


class EventWebhookRequest(BaseModel):
    """POST /webhooks/events — Vonage call state transitions."""

    model_config = ConfigDict(extra="allow")

    status: EventStatus
    uuid: str
    conversation_uuid: str | None = None
    timestamp: datetime | None = None
    direction: Literal["inbound", "outbound"] | None = None
    duration: int | str | None = None
    price: str | None = None
    rate: str | None = None
    network: str | None = None
    from_: str | None = Field(default=None, alias="from")
    to: str | None = None
    reason_code: str | int | None = None
    reason: str | None = None


# ─── Dashboard WS events (tagged union via discriminator) ───


class CallStarted(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["call_started"] = "call_started"
    call_uuid: str
    caller_phone_masked: str | None = None
    started_at: datetime


class TranscriptPartial(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["transcript_partial"] = "transcript_partial"
    call_uuid: str
    text: str
    confidence: float | None = None


class TranscriptFinal(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["transcript_final"] = "transcript_final"
    call_uuid: str
    role: Literal["user", "assistant"]
    text: str
    ts: datetime
    confidence: float | None = None


class IntentClassified(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["intent_classified"] = "intent_classified"
    call_uuid: str
    intent: str
    confidence: float


class EntitiesExtracted(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["entities_extracted"] = "entities_extracted"
    call_uuid: str
    entities: SessionEntities


class VehicleResults(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["vehicle_results"] = "vehicle_results"
    call_uuid: str
    vehicles: list[Vehicle]


class CallOutcome(str, Enum):
    ANSWERED = "answered"
    TRANSFERRED = "transferred"
    DROPPED = "dropped"
    FAILED = "failed"


class CallEnded(BaseModel):
    model_config = ConfigDict(extra="forbid")

    type: Literal["call_ended"] = "call_ended"
    call_uuid: str
    ended_at: datetime
    outcome: CallOutcome
    duration_seconds: int = Field(ge=0)
