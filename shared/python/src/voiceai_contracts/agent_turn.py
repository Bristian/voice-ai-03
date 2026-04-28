"""AgentTurn request/response — the primary agent-api contract.

Mirrors shared/contracts/agent-turn.schema.json.
Used on POST /v1/agent/turn — called by echokit-server on every final STT transcript.
"""

from __future__ import annotations

from enum import Enum

from pydantic import BaseModel, ConfigDict, Field

from voiceai_contracts.session import ConversationTurn, Intent, SessionEntities
from voiceai_contracts.vehicle import Vehicle


class Action(str, Enum):
    RESPOND = "respond"
    TRANSFER = "transfer"
    COLLECT_LEAD = "collect_lead"
    END_CALL = "end_call"


class RagSource(str, Enum):
    FAQ = "faq"
    POLICY = "policy"
    PROMO = "promo"
    FINANCING = "financing"
    SERVICE = "service"


class RagChunk(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str | None = None
    source: RagSource
    content: str
    score: float = Field(ge=0.0, le=1.0)


class LatencyMetrics(BaseModel):
    model_config = ConfigDict(extra="forbid")

    intent_ms: float = Field(default=0.0, ge=0.0)
    rag_ms: float = Field(default=0.0, ge=0.0)
    sql_ms: float = Field(default=0.0, ge=0.0)
    synthesis_ms: float = Field(default=0.0, ge=0.0)
    total_ms: float = Field(default=0.0, ge=0.0)


class AgentTurnResults(BaseModel):
    model_config = ConfigDict(extra="forbid")

    rag_chunks: list[RagChunk] = Field(default_factory=list)
    vehicles: list[Vehicle] = Field(default_factory=list)


class AgentTurnRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    call_uuid: str = Field(min_length=1)
    transcript: str
    caller_phone_hash: str
    session_entities: SessionEntities = Field(default_factory=SessionEntities)
    conversation_history: list[ConversationTurn] = Field(default_factory=list)
    stt_confidence: float | None = Field(default=None, ge=0.0, le=1.0)


class AgentTurnResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    response_text: str
    intent: Intent
    intent_confidence: float = Field(default=0.0, ge=0.0, le=1.0)
    updated_entities: SessionEntities = Field(default_factory=SessionEntities)
    results: AgentTurnResults = Field(default_factory=AgentTurnResults)
    action: Action
    transfer_to: str | None = Field(default=None, pattern=r"^\+[1-9][0-9]{7,14}$")
    latency_ms: LatencyMetrics = Field(default_factory=LatencyMetrics)
