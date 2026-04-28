/**
 * Vonage webhook routes.
 *
 * Vonage calls these URLs at key moments in the call lifecycle:
 *
 *   POST /webhooks/answer     — when a call arrives. We return an NCCO that
 *                                tells Vonage to greet the caller with TTS
 *                                and then connect audio to our WebSocket.
 *
 *   POST /webhooks/events     — state transitions (ringing, answered, completed,
 *                                failed, etc). We just log and return 200.
 *
 *   POST /webhooks/fallback   — catches errors when the answer webhook itself
 *                                fails. Plays a static apology so the caller
 *                                doesn't hear dead air.
 *
 * All routes support optional signature verification via the middleware in
 * vonage-signature.js.
 */

import { Router } from "express";
import { z } from "zod";
import { config, getWebSocketUrl } from "./config.js";
import { forCall, logger } from "./logger.js";
import { vonageSignatureMiddleware } from "./vonage-signature.js";

export function createWebhookRouter() {
  const router = Router();
  const verify = vonageSignatureMiddleware();

  // ─── Lightweight request validation schemas ───
  // We're permissive with Vonage payloads because they include extra fields
  // that vary by call type. We only care about a few canonical fields.
  const AnswerBody = z
    .object({
      uuid: z.string().optional(),
      conversation_uuid: z.string().optional(),
      from: z.string().optional(),
      to: z.string().optional(),
    })
    .passthrough();

  const EventBody = z
    .object({
      status: z.string().optional(),
      uuid: z.string().optional(),
      conversation_uuid: z.string().optional(),
      direction: z.string().optional(),
      duration: z.union([z.string(), z.number()]).optional(),
    })
    .passthrough();

  // ─── POST /webhooks/answer ───
  // Vonage hits this when a call arrives. We respond with an NCCO array.
  router.post("/webhooks/answer", verify, (req, res) => {
    // Vonage sends answer as GET sometimes; accept body or query.
    const payload = { ...(req.query ?? {}), ...(req.body ?? {}) };
    const parsed = AnswerBody.safeParse(payload);
    const data = parsed.success ? parsed.data : payload;

    const callUuid = data.uuid ?? data.conversation_uuid ?? "unknown";
    const callLog = forCall(callUuid);
    callLog.info(
      { from: data.from, to: data.to, conversation_uuid: data.conversation_uuid },
      "Answer webhook received"
    );

    // NCCO = Nexmo Call Control Object. Vonage executes actions in order.
    //
    // Step 1: Vonage's built-in TTS speaks the greeting to the caller.
    //         This gives us a zero-latency greeting (no OpenAI round-trip)
    //         and serves as our "call is connected" signal to the caller.
    //
    // Step 2: Vonage opens a WebSocket to us at /ws/voice and starts streaming
    //         the caller's audio as 16kHz / 16-bit / mono PCM in 640-byte
    //         frames. Any audio WE write back gets played to the caller.
    const ncco = [
      {
        action: "talk",
        text: config.GREETING_TEXT,
        bargeIn: false,
        // Vonage's TTS accepts `language` and `style` but defaults are fine.
      },
      {
        action: "connect",
        endpoint: [
          {
            type: "websocket",
            uri: getWebSocketUrl(),
            "content-type": "audio/l16;rate=16000",
            headers: {
              // These headers are passed to our WebSocket as extra fields on
              // the initial `websocket:connected` JSON text frame, under their
              // original names (no x- prefix added).
              call_uuid: callUuid,
              from: data.from ?? "",
              to: data.to ?? "",
            },
          },
        ],
      },
    ];

    res.json(ncco);
  });

  // Vonage historically uses both POST and GET for /answer depending on
  // account config. Accept either to avoid surprise 405s.
  router.get("/webhooks/answer", verify, (req, res) => {
    req.body = req.query;
    // Call the POST handler by re-dispatching. Simpler: duplicate logic.
    const payload = req.query ?? {};
    const callUuid = payload.uuid ?? payload.conversation_uuid ?? "unknown";
    forCall(callUuid).info({ method: "GET", ...payload }, "Answer webhook (GET)");

    const ncco = [
      { action: "talk", text: config.GREETING_TEXT, bargeIn: false },
      {
        action: "connect",
        endpoint: [
          {
            type: "websocket",
            uri: getWebSocketUrl(),
            "content-type": "audio/l16;rate=16000",
            headers: {
              call_uuid: callUuid,
              from: payload.from ?? "",
              to: payload.to ?? "",
            },
          },
        ],
      },
    ];
    res.json(ncco);
  });

  // ─── POST /webhooks/events ───
  // Vonage call state transitions. We log and acknowledge.
  router.post("/webhooks/events", verify, (req, res) => {
    const parsed = EventBody.safeParse(req.body ?? {});
    const data = parsed.success ? parsed.data : req.body ?? {};
    const callUuid = data.uuid ?? data.conversation_uuid ?? "unknown";

    forCall(callUuid).info(
      {
        status: data.status,
        direction: data.direction,
        duration: data.duration,
      },
      `Call event: ${data.status ?? "unknown"}`
    );

    res.sendStatus(200);
  });

  // Some Vonage configurations send events as GET — accept both.
  router.get("/webhooks/events", verify, (req, res) => {
    const data = req.query ?? {};
    const callUuid = data.uuid ?? data.conversation_uuid ?? "unknown";
    forCall(callUuid).info({ ...data }, `Call event (GET): ${data.status ?? "unknown"}`);
    res.sendStatus(200);
  });

  // ─── POST /webhooks/fallback ───
  // Vonage calls this if the answer webhook fetch fails. Play an apology so
  // the caller doesn't hear silence.
  router.post("/webhooks/fallback", (req, res) => {
    const callUuid = req.body?.uuid ?? "unknown";
    forCall(callUuid).error({ body: req.body }, "Fallback webhook triggered — answer failed");

    res.json([
      {
        action: "talk",
        text:
          "We're experiencing a brief technical issue. Please hang up and call back in a moment.",
        bargeIn: false,
      },
    ]);
  });

  return router;
}
