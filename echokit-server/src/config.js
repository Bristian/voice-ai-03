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
  // The NCCO we return to Vonage substitutes `wss://<host>/ws/voice` from this.
  PUBLIC_URL: z
    .string()
    .url()
    .refine((u) => u.startsWith("https://"), {
      message: "PUBLIC_URL must start with https:// (Vonage requires TLS)",
    }),

  // Optional signature secret
  VONAGE_SIGNATURE_SECRET: z.string().optional().default(""),

  // Greeting text — spoken by Vonage's built-in TTS before the WebSocket opens
  GREETING_TEXT: z
    .string()
    .min(1)
    .default(
      "Hello, thanks for calling. This is a test of the voice AI system. After the beep, anything you say will be echoed back to you. Go ahead."
    ),
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
