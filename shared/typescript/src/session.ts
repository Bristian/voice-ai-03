/**
 * Session — per-call working memory.
 * Mirrors ../contracts/session.schema.json.
 * Stored in Redis as JSON under key `session:{call_uuid}` with TTL 2h.
 */

import { z } from "zod";

// ─── Intent enum ───
export const IntentSchema = z.enum([
  "vehicle_search",
  "pricing_query",
  "availability_check",
  "financing_inquiry",
  "dealership_info",
  "appointment_request",
  "human_transfer",
]);
export type Intent = z.infer<typeof IntentSchema>;

// ─── Role ───
export const RoleSchema = z.enum(["user", "assistant"]);
export type Role = z.infer<typeof RoleSchema>;

// ─── ConditionFilter — distinct from Vehicle.Condition to allow `null` in filters ───
export const ConditionFilterSchema = z.enum(["new", "used", "cpo"]);
export type ConditionFilter = z.infer<typeof ConditionFilterSchema>;

// ─── SessionEntities ───
export const SessionEntitiesSchema = z
  .object({
    make: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
    year_min: z.number().int().min(1900).max(2100).nullable().optional(),
    year_max: z.number().int().min(1900).max(2100).nullable().optional(),
    trim: z.string().nullable().optional(),
    color_ext: z.string().nullable().optional(),
    color_int: z.string().nullable().optional(),
    body_style: z.string().nullable().optional(),
    transmission: z.string().nullable().optional(),
    fuel_type: z.string().nullable().optional(),
    price_min: z.number().min(0).nullable().optional(),
    price_max: z.number().min(0).nullable().optional(),
    mileage_max: z.number().int().min(0).nullable().optional(),
    features: z.array(z.string()).default([]),
    condition: ConditionFilterSchema.nullable().optional(),
  })
  .strict();
export type SessionEntities = z.infer<typeof SessionEntitiesSchema>;

// ─── ConversationTurn ───
export const ConversationTurnSchema = z
  .object({
    role: RoleSchema,
    text: z.string(),
    ts: z.string().datetime({ offset: true }),
    confidence: z.number().min(0).max(1).nullable().optional(),
  })
  .strict();
export type ConversationTurn = z.infer<typeof ConversationTurnSchema>;

// ─── Session ───
export const SessionSchema = z
  .object({
    call_uuid: z.string().min(1),
    vonage_conversation_uuid: z.string().optional(),
    caller_phone_hash: z.string().length(64),
    caller_phone_last4: z
      .string()
      .regex(/^[0-9]{4}$/)
      .optional(),
    started_at: z.string().datetime({ offset: true }),
    ended_at: z.string().datetime({ offset: true }).nullable().optional(),
    entities: SessionEntitiesSchema,
    conversation_history: z.array(ConversationTurnSchema),
    tts_playing: z.boolean().default(false),
    intent: IntentSchema.nullable().optional(),
    transfer_attempts: z.number().int().min(0).default(0),
  })
  .strict();
export type Session = z.infer<typeof SessionSchema>;

/**
 * Helper: construct a fresh empty session for a new call.
 */
export function newSession(args: {
  call_uuid: string;
  caller_phone_hash: string;
  caller_phone_last4?: string;
  vonage_conversation_uuid?: string;
}): Session {
  return {
    call_uuid: args.call_uuid,
    vonage_conversation_uuid: args.vonage_conversation_uuid,
    caller_phone_hash: args.caller_phone_hash,
    caller_phone_last4: args.caller_phone_last4,
    started_at: new Date().toISOString(),
    ended_at: null,
    entities: { features: [] },
    conversation_history: [],
    tts_playing: false,
    intent: null,
    transfer_attempts: 0,
  };
}
