/**
 * ElevenLabs Realtime Speech-to-Text — WebSocket client.
 *
 * Streams raw PCM audio from Vonage to ElevenLabs' Scribe Realtime v2 model
 * and receives partial + committed transcripts.
 *
 * Protocol:
 *   1. Connect to wss://api.elevenlabs.io/v1/speech-to-text/realtime
 *   2. Receive `session_started` event
 *   3. Send `input_audio_chunk` messages with base64-encoded PCM audio
 *   4. Receive `partial_transcript` (live preview) and `committed_transcript` (final)
 *   5. Send `commit` message to force finalize, or rely on VAD
 *
 * We use our own VAD (RMS-based) to detect end-of-utterance, then send a
 * `commit` message to get the final transcript quickly rather than waiting
 * for ElevenLabs' own VAD timer.
 */

import WebSocket from "ws";
import { config } from "./config.js";
import { logger } from "./logger.js";

const STT_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";

/**
 * Create a persistent STT session for one call.
 *
 * Returns an object with:
 *   .sendAudio(pcmBuffer)  — feed a 640-byte PCM frame
 *   .commit()              — force-finalize current utterance
 *   .close()               — tear down the WebSocket
 *   .onTranscript(cb)      — register callback for final transcripts
 *   .onPartial(cb)         — register callback for partial transcripts
 *   .ready                 — Promise that resolves when session is established
 */
export function createSttSession(callLog) {
  const log = callLog ?? logger;
  let ws = null;
  let sessionReady = false;
  let manualClose = false;
  let onTranscriptCb = null;
  let onPartialCb = null;

  let readyResolve;
  let ready = new Promise((resolve) => { readyResolve = resolve; });

  function resetReady() {
    ready = new Promise((resolve) => { readyResolve = resolve; });
  }

  function connect() {
    resetReady();
    const url = `${STT_URL}?model_id=scribe_v2_realtime`;

    ws = new WebSocket(url, {
      headers: {
        "xi-api-key": config.ELEVENLABS_API_KEY,
      },
    });

    ws.on("open", () => {
      log.info("ElevenLabs STT WebSocket connected");
      // Send config to set audio format to raw PCM 16kHz (matches Vonage)
      ws.send(JSON.stringify({
        message_type: "session_config",
        audio_format: "pcm_16000",
        sample_rate: 16000,
        language_code: "en",
        // Use manual commit — we trigger it from our own VAD
        vad_commit_strategy: false,
      }));
    });

    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      switch (msg.message_type) {
        case "session_started":
          log.info({ sessionId: msg.session_id }, "STT session started");
          sessionReady = true;
          readyResolve();
          break;

        case "partial_transcript":
          if (msg.text && msg.text.trim().length > 0) {
            log.debug({ text: msg.text }, "STT partial");
            onPartialCb?.(msg.text);
          }
          break;

        case "committed_transcript":
          if (msg.text && msg.text.trim().length > 0) {
            log.info({ text: msg.text }, "STT committed transcript");
            onTranscriptCb?.(msg.text);
          }
          break;

        case "error":
          log.error({ error: msg }, "STT error from ElevenLabs");
          break;

        default:
          log.debug({ type: msg.message_type }, "STT event (ignored)");
      }
    });

    ws.on("close", (code, reason) => {
      log.info({ code, reason: reason?.toString() }, "STT WebSocket closed");
      sessionReady = false;
      // Auto-reconnect unless we explicitly closed
      if (!manualClose) {
        log.info("STT auto-reconnecting…");
        setTimeout(() => {
          if (!manualClose) connect();
        }, 200);
      }
    });

    ws.on("error", (err) => {
      log.error({ err: err.message }, "STT WebSocket error");
      sessionReady = false;
      // Resolve ready promise even on error so callers don't hang
      readyResolve();
    });
  }

  connect();

  return {
    ready,

    /**
     * Send a 640-byte PCM audio frame to ElevenLabs.
     * The frame is base64-encoded as required by the API.
     */
    sendAudio(pcmBuffer) {
      if (!sessionReady || !ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify({
          message_type: "input_audio_chunk",
          audio_base_64: pcmBuffer.toString("base64"),
        }));
      } catch (err) {
        log.warn({ err: err.message }, "Failed to send audio to STT");
      }
    },

    /**
     * Force ElevenLabs to finalize the current utterance.
     * Called when our VAD detects end-of-speech.
     */
    commit() {
      if (!sessionReady || !ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify({
          message_type: "input_audio_chunk",
          audio_base_64: "",
          commit: true,
        }));
        log.debug("STT commit sent");
      } catch (err) {
        log.warn({ err: err.message }, "Failed to send STT commit");
      }
    },

    /** Register callback for committed (final) transcripts. */
    onTranscript(cb) { onTranscriptCb = cb; },

    /** Register callback for partial transcripts. */
    onPartial(cb) { onPartialCb = cb; },

    /** Close the STT WebSocket. No auto-reconnect after this. */
    close() {
      manualClose = true;
      sessionReady = false;
      if (ws) {
        try { ws.close(1000, "session_end"); } catch { /* ignore */ }
        ws = null;
      }
    },
  };
}
