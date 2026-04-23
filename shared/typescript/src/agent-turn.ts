/**
 * AgentTurn request/response — the primary agent-api contract.
 * Mirrors ../contracts/agent-turn.schema.json.
 * Used on POST /v1/agent/turn, called by echokit-server on every final STT transcript.
 */

import { z } from "zod";
import {
  ConversationTurnSchema,
  IntentSchema,
  SessionEntitiesSchema,
} from "./session.js";
import { VehicleSchema } from "./vehicle.js";

export const ActionSchema = z.enum([
  "respond",
  "transfer",
  "collect_lead",
  "end_call",
]);
export type Action = z.infer<typeof ActionSchema>;

export const RagSourceSchema = z.enum([
  "faq",
  "policy",
  "promo",
  "financing",
  "service",
]);
export type RagSource = z.infer<typeof RagSourceSchema>;

export const RagChunkSchema = z
  .object({
    id: z.string().nullable().optional(),
    source: RagSourceSchema,
    content: z.string(),
    score: z.number().min(0).max(1),
  })
  .strict();
export type RagChunk = z.infer<typeof RagChunkSchema>;

export const LatencyMetricsSchema = z
  .object({
    intent_ms: z.number().min(0).default(0),
    rag_ms: z.number().min(0).default(0),
    sql_ms: z.number().min(0).default(0),
    synthesis_ms: z.number().min(0).default(0),
    total_ms: z.number().min(0).default(0),
  })
  .strict();
export type LatencyMetrics = z.infer<typeof LatencyMetricsSchema>;

export const AgentTurnResultsSchema = z
  .object({
    rag_chunks: z.array(RagChunkSchema).default([]),
    vehicles: z.array(VehicleSchema).default([]),
  })
  .strict();
export type AgentTurnResults = z.infer<typeof AgentTurnResultsSchema>;

export const AgentTurnRequestSchema = z
  .object({
    call_uuid: z.string().min(1),
    transcript: z.string(),
    caller_phone_hash: z.string(),
    session_entities: SessionEntitiesSchema.default({ features: [] }),
    conversation_history: z.array(ConversationTurnSchema).default([]),
    stt_confidence: z.number().min(0).max(1).nullable().optional(),
  })
  .strict();
export type AgentTurnRequest = z.infer<typeof AgentTurnRequestSchema>;

// E.164: + followed by 8-15 digits, first digit non-zero
const E164_REGEX = /^\+[1-9][0-9]{7,14}$/;

export const AgentTurnResponseSchema = z
  .object({
    response_text: z.string(),
    intent: IntentSchema,
    intent_confidence: z.number().min(0).max(1).default(0),
    updated_entities: SessionEntitiesSchema.default({ features: [] }),
    results: AgentTurnResultsSchema.default({ rag_chunks: [], vehicles: [] }),
    action: ActionSchema,
    transfer_to: z.string().regex(E164_REGEX).nullable().optional(),
    latency_ms: LatencyMetricsSchema.default({
      intent_ms: 0,
      rag_ms: 0,
      sql_ms: 0,
      synthesis_ms: 0,
      total_ms: 0,
    }),
  })
  .strict();
export type AgentTurnResponse = z.infer<typeof AgentTurnResponseSchema>;
