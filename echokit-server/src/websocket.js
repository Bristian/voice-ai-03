/**
 * WebSocket audio server — Vonage Voice API bridge.
 *
 * Slice 2b: full AI pipeline.
 *
 * Flow per utterance:
 *   1. Vonage sends 640-byte PCM frames (16kHz/16-bit/mono) at 50fps
 *   2. RMS-based VAD detects speech start/end
 *   3. During speech: frames are streamed to ElevenLabs Realtime STT
 *   4. On silence (end of utterance): commit STT → get final transcript
 *   5. Post transcript to agent-api /v1/agent/turn → get response text
 *   6. Stream response text through OpenAI TTS → get PCM frames
 *   7. Send PCM frames back to Vonage at 50fps → caller hears AI speak
 *   8. If agent says "transfer" → we'd trigger Vonage transfer (future)
 *
 * Barge-in: if caller speaks while TTS is playing, cancel TTS immediately
 * and start processing the new utterance.
 *
 * Falls back to echo mode if AI pipeline env vars aren't configured.
 */

import { WebSocketServer } from "ws";
import { config, aiPipelineEnabled } from "./config.js";
import { forCall, logger } from "./logger.js";
import { createSttSession } from "./stt.js";
import { streamTts } from "./tts.js";
import { agentTurn } from "./agent-client.js";
import {
  emitCallStarted,
  emitTranscriptPartial,
  emitTranscriptFinal,
  emitIntentClassified,
  emitAgentResponse,
  emitCallEnded,
} from "./supervisor.js";

// ─── Audio protocol constants ───
const FRAME_BYTES = 640;        // 20ms of 16kHz/16-bit/mono PCM
const FRAMES_PER_SEC = 50;

// ─── VAD constants (from config) ───
const SILENCE_FRAMES_TO_END = () => config.SILENCE_FRAMES;
const SILENCE_RMS_THRESHOLD = () => config.SILENCE_RMS_THRESHOLD;
const MIN_SPEECH_FRAMES = 10;   // 200ms minimum utterance
const MAX_SPEECH_FRAMES = FRAMES_PER_SEC * 15; // 15s max utterance

/**
 * Compute RMS of a 16-bit PCM frame for silence detection.
 */
function frameRms(buf) {
  if (buf.length < 2) return 0;
  let sumSq = 0;
  let n = 0;
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const sample = buf.readInt16LE(i);
    sumSq += sample * sample;
    n++;
  }
  return n === 0 ? 0 : Math.sqrt(sumSq / n);
}

/**
 * Per-connection call session with full AI pipeline.
 */
class CallSession {
  constructor(ws, log) {
    this.ws = ws;
    this.log = log;
    this.callUuid = null;
    this.callerPhone = "";
    this.connectedAt = Date.now();

    // Audio stats
    this.framesReceived = 0;
    this.framesSent = 0;
    this.turnCount = 0;

    // VAD state
    this.speechActive = false;
    this.silentFrames = 0;
    this.speechFrames = 0;

    // TTS playback state
    this.ttsPlaying = false;
    this.ttsAbortController = null;
    this.playbackTimer = null;
    this.playbackQueue = [];   // queued PCM frames to send

    // Conversation state (persisted across turns within this call)
    this.sessionEntities = {};
    this.conversationHistory = [];

    // STT session (created on first use)
    this.stt = null;

    // Pipeline mode
    this.useAiPipeline = aiPipelineEnabled();
    if (!this.useAiPipeline) {
      log.warn("AI pipeline disabled (missing ELEVENLABS_API_KEY or OPENAI_API_KEY). Using echo mode.");
    }
  }

  handleText(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.log.warn({ raw: String(raw).slice(0, 200) }, "Non-JSON text frame");
      return;
    }

    const event = msg.event ?? "(no event)";

    if (event === "websocket:connected") {
      this.callUuid = msg.call_uuid ?? msg.callUuid ?? null;
      this.callerPhone = msg.from ?? "";
      if (this.callUuid) {
        this.log = forCall(this.callUuid);
      }
      this.log.info(
        { from: msg.from, to: msg.to, contentType: msg["content-type"], aiPipeline: this.useAiPipeline },
        "Call audio stream established"
      );

      // Notify dashboard
      emitCallStarted({
        callUuid: this.callUuid,
        callerPhone: this.callerPhone,
        startedAt: new Date().toISOString(),
      });

      // Initialize STT session for this call
      if (this.useAiPipeline) {
        this._initStt();
      }
    } else if (event === "websocket:disconnected") {
      this.log.info("Vonage signaled disconnect");
    }
  }

  handleBinary(chunk) {
    if (chunk.length !== FRAME_BYTES) return;
    this.framesReceived++;

    // Log throughput every 5 seconds
    if (this.framesReceived % (FRAMES_PER_SEC * 5) === 0) {
      this.log.debug({ sec: this.framesReceived / FRAMES_PER_SEC }, "Audio received");
    }

    if (!this.useAiPipeline) {
      this._handleBinaryEcho(chunk);
      return;
    }

    this._handleBinaryAi(chunk);
  }

  /**
   * AI pipeline: VAD → STT → agent → TTS
   */
  _handleBinaryAi(chunk) {
    const rms = frameRms(chunk);
    const isSpeech = rms >= SILENCE_RMS_THRESHOLD();

    // ── During TTS playback: stricter barge-in detection ──
    // The caller's own speaker audio can leak back through the mic,
    // causing false barge-in triggers. We require:
    //   1. Higher RMS threshold (echo is quieter than direct speech)
    //   2. Sustained speech over multiple frames (echo is intermittent)
    if (this.ttsPlaying) {
      const BARGE_IN_RMS = SILENCE_RMS_THRESHOLD() * 2; // 2x normal threshold
      const BARGE_IN_MIN_FRAMES = 8; // 160ms of sustained speech

      if (rms >= BARGE_IN_RMS) {
        this._bargeInFrames = (this._bargeInFrames || 0) + 1;
      } else {
        this._bargeInFrames = 0;
      }

      if (this._bargeInFrames >= BARGE_IN_MIN_FRAMES) {
        this.log.info({ rms: Math.round(rms), frames: this._bargeInFrames }, "Barge-in confirmed — canceling TTS");
        this._stopPlayback();
        this._bargeInFrames = 0;
        // Start processing the new utterance
        this.speechActive = true;
        this.speechFrames = BARGE_IN_MIN_FRAMES;
        this.silentFrames = 0;
        this.stt?.sendAudio(chunk);
      }
      // During TTS playback, don't process audio as normal speech
      return;
    }

    // ── Normal (not during TTS): standard VAD ──
    if (isSpeech) {
      if (!this.speechActive) {
        this.speechActive = true;
        this.speechFrames = 0;
        this.silentFrames = 0;
        this.log.info({ rms: Math.round(rms) }, "Speech start");
      }

      this.speechFrames++;
      this.silentFrames = 0;

      // Stream audio to STT
      this.stt?.sendAudio(chunk);

      // Safety cap on utterance length
      if (this.speechFrames >= MAX_SPEECH_FRAMES) {
        this.log.warn("Max utterance length reached — forcing commit");
        this._endUtterance();
      }
    } else if (this.speechActive) {
      // Still send silence to STT (helps with context)
      this.stt?.sendAudio(chunk);
      this.silentFrames++;

      if (this.silentFrames >= SILENCE_FRAMES_TO_END() && this.speechFrames >= MIN_SPEECH_FRAMES) {
        this._endUtterance();
      }
    }
    // If not speaking and TTS not playing: just drop the frame (silence on the line)
  }

  /**
   * End of utterance detected — commit STT and wait for transcript.
   */
  _endUtterance() {
    this.log.info(
      { speechFrames: this.speechFrames, speechMs: this.speechFrames * 20 },
      "End of utterance — committing STT"
    );
    this.speechActive = false;
    this.speechFrames = 0;
    this.silentFrames = 0;

    // Force ElevenLabs to finalize
    this.stt?.commit();
  }

  /**
   * Called when STT delivers a committed transcript.
   */
  async _onTranscript(text) {
    this.turnCount++;
    this.log.info({ turn: this.turnCount, text }, "Processing turn");

    // Notify dashboard: caller's transcript
    emitTranscriptFinal({
      callUuid: this.callUuid,
      role: "user",
      text,
    });

    try {
      // Call agent-api
      const result = await agentTurn({
        callUuid: this.callUuid ?? "unknown",
        transcript: text,
        callerPhone: this.callerPhone,
        sessionEntities: this.sessionEntities,
        conversationHistory: this.conversationHistory.slice(-6),
        log: this.log,
      });

      // Notify dashboard: intent + agent response
      emitIntentClassified({
        callUuid: this.callUuid,
        intent: result.intent,
        confidence: result.intent_confidence,
      });
      emitAgentResponse({
        callUuid: this.callUuid,
        responseText: result.response_text,
        intent: result.intent,
        action: result.action,
        vehicles: result.results?.vehicles,
        latencyMs: result.latency_ms?.total_ms,
      });

      // Update session state
      if (result.updated_entities) {
        this.sessionEntities = result.updated_entities;
      }
      this.conversationHistory.push(
        { role: "user", text, ts: new Date().toISOString() },
        { role: "assistant", text: result.response_text, ts: new Date().toISOString() }
      );

      // Speak the response via TTS
      const responseText = result.response_text;
      if (responseText && responseText.length > 0) {
        // Notify dashboard: AI's response as transcript
        emitTranscriptFinal({
          callUuid: this.callUuid,
          role: "assistant",
          text: responseText,
        });
        await this._speakResponse(responseText);
      }

      // Handle transfer action (future: trigger Vonage transfer)
      if (result.action === "transfer") {
        this.log.info({ transferTo: result.transfer_to }, "Agent requested transfer");
      }
    } catch (err) {
      this.log.error({ err: err.message, stack: err.stack?.split("\n").slice(0, 3).join(" | ") }, "Turn processing failed");
      await this._speakResponse("I apologize for the delay. Could you repeat your question?");
    }
  }

  /**
   * Stream text through OpenAI TTS and send PCM frames to Vonage.
   */
  async _speakResponse(text) {
    return new Promise((resolve) => {
      this.ttsPlaying = true;
      this.playbackQueue = [];

      streamTts(text, {
        onFrame: (frame) => {
          if (!this.ttsPlaying) return; // barge-in happened
          this.playbackQueue.push(frame);

          // Start playback timer if not already running
          if (!this.playbackTimer) {
            this._startPlayback();
          }
        },
        onDone: () => {
          // TTS generation complete — playback continues from queue
          this.log.debug("TTS generation done, draining playback queue");
          // Resolve once playback queue is drained (handled in _startPlayback)
          this._onPlaybackDrainResolve = resolve;
          this._ttsGenerationDone = true;
        },
        onError: (err) => {
          this.log.error({ err: err.message }, "TTS error");
          this._stopPlayback();
          resolve();
        },
        log: this.log,
      });
    });
  }

  /**
   * Send queued PCM frames to Vonage at 50fps real-time pacing.
   */
  _startPlayback() {
    if (this.playbackTimer) return;

    this._ttsGenerationDone = false;
    this._onPlaybackDrainResolve = null;

    this.playbackTimer = setInterval(() => {
      if (!this.ttsPlaying || this.ws.readyState !== 1) {
        this._stopPlayback();
        return;
      }

      if (this.playbackQueue.length > 0) {
        const frame = this.playbackQueue.shift();
        try {
          this.ws.send(frame);
          this.framesSent++;
        } catch (err) {
          this.log.warn({ err: err.message }, "WS send failed during TTS playback");
          this._stopPlayback();
          return;
        }
      } else if (this._ttsGenerationDone) {
        // Queue empty and TTS generation is done — playback complete
        this.log.info({ framesSent: this.framesSent }, "TTS playback complete");
        this._stopPlayback();
      }
      // else: queue empty but TTS still generating — wait for more frames
    }, 20); // 50fps
  }

  _stopPlayback() {
    this.ttsPlaying = false;
    if (this.playbackTimer) {
      clearInterval(this.playbackTimer);
      this.playbackTimer = null;
    }
    this.playbackQueue = [];
    this._onPlaybackDrainResolve?.();
    this._onPlaybackDrainResolve = null;
  }

  /**
   * Initialize the ElevenLabs STT session.
   */
  _initStt() {
    this.stt = createSttSession(this.log);

    this.stt.onTranscript((text) => {
      this._onTranscript(text).catch((err) => {
        this.log.error({ err: err.message }, "Transcript handler error");
      });
    });

    this.stt.onPartial((text) => {
      this.log.debug({ partial: text.slice(0, 80) }, "STT partial");
      // Stream partial transcripts to dashboard for live preview
      emitTranscriptPartial({
        callUuid: this.callUuid,
        text,
      });
    });
  }

  // ─── Echo mode fallback (from slice 1) ────────────────────

  _echoCapture = [];
  _echoSilentFrames = 0;
  _echoSpeechActive = false;

  _handleBinaryEcho(chunk) {
    const rms = frameRms(chunk);
    const isSpeech = rms >= SILENCE_RMS_THRESHOLD();

    if (this.playbackTimer) return; // replaying

    if (isSpeech) {
      if (!this._echoSpeechActive) {
        this._echoSpeechActive = true;
        this.log.info({ rms: Math.round(rms) }, "Speech start (echo mode)");
      }
      this._echoCapture.push(chunk);
      this._echoSilentFrames = 0;
      if (this._echoCapture.length >= FRAMES_PER_SEC * 5) {
        this._startEchoReplay();
      }
    } else if (this._echoSpeechActive) {
      this._echoCapture.push(chunk);
      this._echoSilentFrames++;
      if (this._echoSilentFrames >= SILENCE_FRAMES_TO_END() && this._echoCapture.length >= MIN_SPEECH_FRAMES) {
        this._startEchoReplay();
      }
    }
  }

  _startEchoReplay() {
    const frames = this._echoCapture.slice();
    this._echoCapture = [];
    this._echoSpeechActive = false;
    this._echoSilentFrames = 0;
    this.ttsPlaying = true;
    let idx = 0;

    this.playbackTimer = setInterval(() => {
      if (this.ws.readyState !== 1 || idx >= frames.length) {
        this._stopPlayback();
        return;
      }
      this.ws.send(frames[idx++]);
      this.framesSent++;
    }, 20);
  }

  // ─── Lifecycle ────────────────────────────────────────────

  handleClose(code, reason) {
    this._stopPlayback();
    this.stt?.close();
    const durationMs = Date.now() - this.connectedAt;
    this.log.info(
      {
        code,
        reason: reason?.toString() ?? "",
        durationMs,
        framesReceived: this.framesReceived,
        framesSent: this.framesSent,
        turns: this.turnCount,
        mode: this.useAiPipeline ? "ai" : "echo",
      },
      "Call WebSocket closed"
    );

    // Notify dashboard
    emitCallEnded({
      callUuid: this.callUuid,
      outcome: "completed",
      durationMs,
      turns: this.turnCount,
    });

    // Persist call session to agent-api (fire-and-forget)
    this._saveSession(durationMs).catch((err) => {
      this.log.warn({ err: err.message }, "Failed to save call session");
    });
  }

  async _saveSession(durationMs) {
    if (!this.callUuid || !this.useAiPipeline) return;
    const transcript = this.conversationHistory
      .map((t) => `${t.role}: ${t.text}`)
      .join("\n");

    try {
      await fetch(`${config.AGENT_API_URL}/v1/sessions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          call_uuid: this.callUuid,
          caller_phone_masked: `xxx-xxx-${(this.callerPhone || "0000").slice(-4)}`,
          started_at: new Date(this.connectedAt).toISOString(),
          ended_at: new Date().toISOString(),
          transcript,
          entities: this.sessionEntities,
          outcome: "completed",
          turns: this.turnCount,
          duration_ms: durationMs,
        }),
      });
    } catch (err) {
      this.log.warn({ err: err.message }, "Session save HTTP error");
    }
  }

  handleError(err) {
    this.log.error({ err: err.message, stack: err.stack }, "WS error");
    this._stopPlayback();
    this.stt?.close();
  }
}

/**
 * Attach a WebSocket server to the given HTTP server on /ws/voice.
 */
export function attachWebSocketServer(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");

    // Only handle /ws/voice here. Socket.io handles its own upgrades
    // on the /supervisor path — we must NOT reject them.
    if (url.pathname === "/ws/voice") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    } else if (!url.pathname.startsWith("/supervisor")) {
      // Reject unknown WS paths (but not /supervisor — Socket.io handles that)
      logger.warn({ path: url.pathname }, "Rejecting WS upgrade for unknown path");
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
    }
    // else: /supervisor path — Socket.io's internal upgrade handler picks this up
  });

  wss.on("connection", (ws, request) => {
    const connId = `conn-${Date.now().toString(36)}-${Math.floor(
      Math.random() * 1000
    ).toString(36).padStart(3, "0")}`;
    const log = logger.child({ conn_id: connId });

    log.info(
      { remoteAddress: request.socket.remoteAddress },
      "Vonage WebSocket connected"
    );

    const session = new CallSession(ws, log);

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        session.handleBinary(data);
      } else {
        session.handleText(data.toString("utf8"));
      }
    });

    ws.on("close", (code, reason) => session.handleClose(code, reason));
    ws.on("error", (err) => session.handleError(err));
  });

  return wss;
}
