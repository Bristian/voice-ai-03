/**
 * Event payloads — Vonage webhooks + supervisor dashboard WS events.
 * Mirrors ../contracts/webhook-events.schema.json and ws-events.schema.json.
 */

import { z } from "zod";
import { SessionEntitiesSchema } from "./session.js";
import { VehicleSchema } from "./vehicle.js";

// ─────────────────────────────────────────────────────────────
// VONAGE WEBHOOK PAYLOADS
// ─────────────────────────────────────────────────────────────

export const EventStatusSchema = z.enum([
  "started",
  "ringing",
  "answered",
  "busy",
  "cancelled",
  "failed",
  "rejected",
  "timeout",
  "unanswered",
  "completed",
  "machine",
  "human",
]);
export type EventStatus = z.infer<typeof EventStatusSchema>;

/** POST /webhooks/answer body. Extra fields are allowed (Vonage adds custom headers). */
export const AnswerWebhookRequestSchema = z
  .object({
    uuid: z.string(),
    conversation_uuid: z.string().optional(),
    from: z.string(),
    to: z.string(),
    region_url: z.string().optional(),
    custom_data: z.record(z.unknown()).optional(),
  })
  .passthrough();
export type AnswerWebhookRequest = z.infer<typeof AnswerWebhookRequestSchema>;

/** POST /webhooks/events body. */
export const EventWebhookRequestSchema = z
  .object({
    status: EventStatusSchema,
    uuid: z.string(),
    conversation_uuid: z.string().optional(),
    timestamp: z.string().optional(),
    direction: z.enum(["inbound", "outbound"]).optional(),
    // Vonage sends duration as string sometimes, number others
    duration: z.union([z.string(), z.number()]).optional(),
    price: z.string().optional(),
    rate: z.string().optional(),
    network: z.string().optional(),
    from: z.string().optional(),
    to: z.string().optional(),
    reason_code: z.union([z.string(), z.number()]).optional(),
    reason: z.string().optional(),
  })
  .passthrough();
export type EventWebhookRequest = z.infer<typeof EventWebhookRequestSchema>;

// ─────────────────────────────────────────────────────────────
// NCCO — the response body for /webhooks/answer
// ─────────────────────────────────────────────────────────────

export const TalkActionSchema = z
  .object({
    action: z.literal("talk"),
    text: z.string(),
    bargeIn: z.boolean().default(false),
    loop: z.number().int().default(1),
    level: z.number().optional(),
    language: z.string().optional(),
    style: z.number().int().optional(),
  })
  .strict();
export type TalkAction = z.infer<typeof TalkActionSchema>;

export const WebsocketEndpointSchema = z
  .object({
    type: z.literal("websocket"),
    uri: z.string().url(),
    "content-type": z.string().optional(),
    headers: z.record(z.string()).optional(),
  })
  .strict();

export const PhoneEndpointSchema = z
  .object({
    type: z.literal("phone"),
    number: z.string(),
  })
  .strict();

export const ConnectActionSchema = z
  .object({
    action: z.literal("connect"),
    endpoint: z
      .array(z.union([WebsocketEndpointSchema, PhoneEndpointSchema]))
      .min(1),
    timeout: z.number().int().optional(),
    from: z.string().optional(),
  })
  .strict();
export type ConnectAction = z.infer<typeof ConnectActionSchema>;

export const NccoSchema = z.array(
  z.union([TalkActionSchema, ConnectActionSchema])
);
export type Ncco = z.infer<typeof NccoSchema>;

// ─────────────────────────────────────────────────────────────
// DASHBOARD WS EVENTS (discriminated union on `type`)
// ─────────────────────────────────────────────────────────────

export const CallStartedSchema = z
  .object({
    type: z.literal("call_started"),
    call_uuid: z.string(),
    caller_phone_masked: z.string().optional(),
    started_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type CallStarted = z.infer<typeof CallStartedSchema>;

export const TranscriptPartialSchema = z
  .object({
    type: z.literal("transcript_partial"),
    call_uuid: z.string(),
    text: z.string(),
    confidence: z.number().nullable().optional(),
  })
  .strict();
export type TranscriptPartial = z.infer<typeof TranscriptPartialSchema>;

export const TranscriptFinalSchema = z
  .object({
    type: z.literal("transcript_final"),
    call_uuid: z.string(),
    role: z.enum(["user", "assistant"]),
    text: z.string(),
    ts: z.string().datetime({ offset: true }),
    confidence: z.number().nullable().optional(),
  })
  .strict();
export type TranscriptFinal = z.infer<typeof TranscriptFinalSchema>;

export const IntentClassifiedSchema = z
  .object({
    type: z.literal("intent_classified"),
    call_uuid: z.string(),
    intent: z.string(),
    confidence: z.number(),
  })
  .strict();
export type IntentClassified = z.infer<typeof IntentClassifiedSchema>;

export const EntitiesExtractedSchema = z
  .object({
    type: z.literal("entities_extracted"),
    call_uuid: z.string(),
    entities: SessionEntitiesSchema,
  })
  .strict();
export type EntitiesExtracted = z.infer<typeof EntitiesExtractedSchema>;

export const VehicleResultsSchema = z
  .object({
    type: z.literal("vehicle_results"),
    call_uuid: z.string(),
    vehicles: z.array(VehicleSchema),
  })
  .strict();
export type VehicleResults = z.infer<typeof VehicleResultsSchema>;

export const CallOutcomeSchema = z.enum([
  "answered",
  "transferred",
  "dropped",
  "failed",
]);
export type CallOutcome = z.infer<typeof CallOutcomeSchema>;

export const CallEndedSchema = z
  .object({
    type: z.literal("call_ended"),
    call_uuid: z.string(),
    ended_at: z.string().datetime({ offset: true }),
    outcome: CallOutcomeSchema,
    duration_seconds: z.number().int().min(0),
  })
  .strict();
export type CallEnded = z.infer<typeof CallEndedSchema>;

/**
 * Discriminated union of all dashboard WS events.
 * Consumers can switch on `.type` for exhaustive handling.
 */
export const WsEventSchema = z.discriminatedUnion("type", [
  CallStartedSchema,
  TranscriptPartialSchema,
  TranscriptFinalSchema,
  IntentClassifiedSchema,
  EntitiesExtractedSchema,
  VehicleResultsSchema,
  CallEndedSchema,
]);
export type WsEvent = z.infer<typeof WsEventSchema>;
