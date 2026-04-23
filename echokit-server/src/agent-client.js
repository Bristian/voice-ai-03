/**
 * Agent API client — calls the agent-api service for conversational turns.
 *
 * This is a simple HTTP POST to /v1/agent/turn. The agent-api runs the full
 * pipeline (intent → parallel RAG + SQL → synthesis) and returns a voice-ready
 * response.
 */

import { config } from "./config.js";
import { logger } from "./logger.js";
import crypto from "node:crypto";

/**
 * Execute a full conversational turn via agent-api.
 *
 * @param {object} params
 * @param {string} params.callUuid
 * @param {string} params.transcript - The caller's latest utterance (from STT)
 * @param {string} params.callerPhone - Caller's phone number (will be hashed)
 * @param {object} [params.sessionEntities] - Accumulated entities from prior turns
 * @param {Array} [params.conversationHistory] - Prior turns for context
 * @param {object} [params.log] - Pino logger instance
 * @returns {Promise<object>} AgentTurnResponse
 */
export async function agentTurn({
  callUuid,
  transcript,
  callerPhone = "",
  sessionEntities = {},
  conversationHistory = [],
  log: callLog,
}) {
  const log = callLog ?? logger;
  const url = `${config.AGENT_API_URL}/v1/agent/turn`;

  // Hash the phone number — never send raw PII to the agent
  const phoneHash = crypto
    .createHash("sha256")
    .update(callerPhone || "unknown")
    .digest("hex");

  const body = {
    call_uuid: callUuid,
    transcript,
    caller_phone_hash: phoneHash,
    session_entities: sessionEntities,
    conversation_history: conversationHistory,
  };

  log.info(
    { transcript: transcript.slice(0, 100), intent: "pending" },
    "Calling agent-api"
  );

  const t0 = Date.now();

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      throw new Error(`agent-api HTTP ${resp.status}: ${errText.slice(0, 300)}`);
    }

    const data = await resp.json();
    const elapsed = Date.now() - t0;

    log.info(
      {
        elapsedMs: elapsed,
        intent: data.intent,
        action: data.action,
        responseLen: data.response_text?.length,
        vehicleCount: data.results?.vehicles?.length ?? 0,
      },
      "Agent turn complete"
    );

    return data;
  } catch (err) {
    log.error({ err: err.message, elapsedMs: Date.now() - t0 }, "Agent turn failed");
    throw err;
  }
}
