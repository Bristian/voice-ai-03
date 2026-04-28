/**
 * Config — load and validate environment variables.
 *
 * All env vars are read here once at startup. If a required var is missing,
 * the process exits immediately with a clear error message. This prevents
 * "mystery 500s" later when something tries to use an undefined value.
 */

import { z } from "zod";

const EnvSchema = z.object({
  // Server
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error", "fatal"])
    .default("info"),

  // Public URL — REQUIRED. Must be a full https:// URL.
  PUBLIC_URL: z
    .string()
    .url()
    .refine((u) => u.startsWith("https://"), {
      message: "PUBLIC_URL must start with https:// (Vonage requires TLS)",
    }),

  // Agent API — the agent-api service URL. Required for AI mode.
  AGENT_API_URL: z.string().default("http://localhost:8000"),

  // ElevenLabs — for STT. Empty = echo mode fallback.
  ELEVENLABS_API_KEY: z.string().default(""),

  // OpenAI — for TTS. Empty = echo mode fallback.
  OPENAI_API_KEY: z.string().default(""),

  // Optional signature secret
  VONAGE_SIGNATURE_SECRET: z.string().optional().default(""),

  // Greeting text — spoken by Vonage's built-in TTS before the WebSocket opens
  GREETING_TEXT: z
    .string()
    .min(1)
    .default(
      "Hello, thanks for calling the dealership. How can I help you today?"
    ),

  // ─── Tuning ───
  // Silence duration (in 20ms frames) to consider end-of-utterance.
  // 40 frames = 0.8s. Lower = faster response, higher = fewer false triggers.
  SILENCE_FRAMES: z.coerce.number().int().positive().default(40),

  // RMS threshold for speech detection. Phone lines: 200-400 quiet, 2000+ speech.
  SILENCE_RMS_THRESHOLD: z.coerce.number().positive().default(800),
});

function loadEnv() {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    // eslint-disable-next-line no-console
    console.error("❌  Invalid environment configuration:");
    for (const issue of parsed.error.issues) {
      // eslint-disable-next-line no-console
      console.error(`   • ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }
  return parsed.data;
}

export const config = loadEnv();

/** Derive the wss:// URL for Vonage's WebSocket connect action. */
export function getWebSocketUrl() {
  const url = new URL(config.PUBLIC_URL);
  const proto = url.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${url.host}/ws/voice`;
}

/** True when signature verification is enabled. */
export function signatureEnabled() {
  return config.VONAGE_SIGNATURE_SECRET.length > 0;
}

/** True when AI pipeline is configured (STT + TTS + agent-api). */
export function aiPipelineEnabled() {
  return (
    config.ELEVENLABS_API_KEY.length > 0 &&
    config.OPENAI_API_KEY.length > 0 &&
    config.AGENT_API_URL.length > 0
  );
}
