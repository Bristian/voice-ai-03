/**
 * Supervisor event bus — Socket.io server for the dashboard.
 *
 * Emits real-time events as calls progress:
 *   - call_started: new call connected
 *   - transcript_partial: live STT preview
 *   - transcript_final: committed transcript (user or assistant)
 *   - intent_classified: agent determined the caller's intent
 *   - agent_response: the AI's response text + metadata
 *   - call_ended: call completed with outcome + duration
 *
 * Dashboard clients connect to /supervisor namespace and can subscribe
 * to specific calls or receive all events.
 */

import { Server as SocketIOServer } from "socket.io";
import { logger } from "./logger.js";

let _io = null;

/**
 * Attach Socket.io to the HTTP server.
 * Must be called after the HTTP server is created but before listen().
 */
export function attachSupervisorSocket(httpServer) {
  _io = new SocketIOServer(httpServer, {
    path: "/supervisor",
    cors: {
      origin: "*", // Allow dashboard from any origin (tighten in production)
      methods: ["GET", "POST"],
    },
    // Don't interfere with the Vonage WebSocket on /ws/voice
    serveClient: false,
  });

  _io.on("connection", (socket) => {
    logger.info(
      { socketId: socket.id, remoteAddress: socket.handshake.address },
      "Supervisor dashboard connected"
    );

    // Client can subscribe to a specific call
    socket.on("subscribe_call", (callUuid) => {
      socket.join(`call:${callUuid}`);
      logger.debug({ callUuid, socketId: socket.id }, "Subscribed to call");
    });

    socket.on("unsubscribe_call", (callUuid) => {
      socket.leave(`call:${callUuid}`);
    });

    socket.on("disconnect", (reason) => {
      logger.info({ socketId: socket.id, reason }, "Supervisor dashboard disconnected");
    });
  });

  logger.info("Supervisor Socket.io attached at /supervisor");
  return _io;
}

/**
 * Emit an event to all connected dashboards and to the specific call room.
 */
function emit(eventType, data) {
  if (!_io) return;
  const payload = { type: eventType, ...data, ts: new Date().toISOString() };

  // Emit to everyone
  _io.emit(eventType, payload);

  // Also emit to the call-specific room (if callUuid is present)
  if (data.call_uuid) {
    _io.to(`call:${data.call_uuid}`).emit(eventType, payload);
  }
}

// ─── Event emitters (called from websocket.js / CallSession) ───

export function emitCallStarted({ callUuid, callerPhone, startedAt }) {
  emit("call_started", {
    call_uuid: callUuid,
    caller_phone_masked: maskPhone(callerPhone),
    started_at: startedAt || new Date().toISOString(),
  });
}

export function emitTranscriptPartial({ callUuid, text, confidence }) {
  emit("transcript_partial", {
    call_uuid: callUuid,
    text,
    confidence: confidence ?? null,
  });
}

export function emitTranscriptFinal({ callUuid, role, text }) {
  emit("transcript_final", {
    call_uuid: callUuid,
    role,
    text,
    ts: new Date().toISOString(),
  });
}

export function emitIntentClassified({ callUuid, intent, confidence }) {
  emit("intent_classified", {
    call_uuid: callUuid,
    intent,
    confidence,
  });
}

export function emitAgentResponse({ callUuid, responseText, intent, action, vehicles, latencyMs }) {
  emit("agent_response", {
    call_uuid: callUuid,
    response_text: responseText,
    intent,
    action,
    vehicle_count: vehicles?.length ?? 0,
    latency_ms: latencyMs,
  });
}

export function emitCallEnded({ callUuid, outcome, durationMs, turns }) {
  emit("call_ended", {
    call_uuid: callUuid,
    outcome: outcome ?? "completed",
    duration_ms: durationMs,
    turns: turns ?? 0,
    ended_at: new Date().toISOString(),
  });
}

/** Mask phone number for display: +1 (xxx) xxx-1234 */
function maskPhone(phone) {
  if (!phone || phone.length < 4) return "unknown";
  return `xxx-xxx-${phone.slice(-4)}`;
}

/** Get connected dashboard count (for health check). */
export function getConnectedDashboards() {
  if (!_io) return 0;
  return _io.engine?.clientsCount ?? 0;
}
