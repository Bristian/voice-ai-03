"""Shared Pydantic contracts for Car Dealership Voice AI.

The JSON Schemas in ../contracts/ are canonical. These models mirror them.
When a schema changes, update both the JSON Schema and the model here, then
run shared/scripts/verify-contracts.mjs.
"""

from voiceai_contracts.session import (
    ConversationTurn,
    Intent,
    Role,
    Session,
    SessionEntities,
)
from voiceai_contracts.vehicle import Condition, Status, Vehicle
from voiceai_contracts.agent_turn import (
    Action,
    AgentTurnRequest,
    AgentTurnResponse,
    LatencyMetrics,
    RagChunk,
    RagSource,
)
from voiceai_contracts.events import (
    AnswerWebhookRequest,
    CallEnded,
    CallOutcome,
    CallStarted,
    EntitiesExtracted,
    EventStatus,
    EventWebhookRequest,
    IntentClassified,
    TranscriptFinal,
    TranscriptPartial,
    VehicleResults,
)

__all__ = [
    # session
    "ConversationTurn",
    "Intent",
    "Role",
    "Session",
    "SessionEntities",
    # vehicle
    "Condition",
    "Status",
    "Vehicle",
    # agent turn
    "Action",
    "AgentTurnRequest",
    "AgentTurnResponse",
    "LatencyMetrics",
    "RagChunk",
    "RagSource",
    # events
    "AnswerWebhookRequest",
    "CallEnded",
    "CallOutcome",
    "CallStarted",
    "EntitiesExtracted",
    "EventStatus",
    "EventWebhookRequest",
    "IntentClassified",
    "TranscriptFinal",
    "TranscriptPartial",
    "VehicleResults",
]

__version__ = "0.1.0"
