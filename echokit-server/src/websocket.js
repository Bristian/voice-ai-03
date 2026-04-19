/**
 * WebSocket audio server — Vonage Voice API bridge.
 *
 * This is the /ws/voice endpoint. Vonage opens a bidirectional WebSocket here
 * when the NCCO `connect → websocket` action runs, then streams the caller's
 * audio to us and plays back any audio we send.
 *
 * Protocol details (verified against Vonage's official docs, Nov 2025):
 *
 *   1. First frame is TEXT, a JSON payload:
 *        { "content-type": "audio/l16;rate=16000",
 *          "event": "websocket:connected",
 *          "call_uuid": "...",  // whatever headers we set in the NCCO
 *          "from": "...", "to": "..." }
 *
 *   2. Subsequent frames are BINARY, each exactly 640 bytes.
 *      - 16 kHz sample rate × 0.020 s × 2 bytes/sample × 1 channel = 640
 *      - 50 frames per second
 *      - 16-bit signed little-endian PCM, mono
 *
 *   3. We send audio BACK to the caller by writing binary 640-byte frames of
 *      the same format. If we send faster than 50 frames/sec, Vonage buffers
 *      and plays at wall-clock rate; if we send slower, the caller hears gaps.
 *
 *   4. Vonage may send "websocket:media:update" (mute events) and
 *      "websocket:disconnected" as text frames. We log and ignore.
 *
 * Slice 1 behaviour: we record the caller's audio into a ring buffer and
 * after they stop speaking (detected by a simple energy threshold), we replay
 * it back to them. This is the classic telephony echo test — it proves
 * bidirectional audio works end to end.
 */

import { WebSocketServer } from "ws";
import { forCall, logger } from "./logger.js";

// ─── Audio protocol constants ───
const SAMPLE_RATE = 16000;
const FRAME_SAMPLES = 320;          // 20 ms of samples
const FRAME_BYTES = FRAME_SAMPLES * 2; // 640 bytes — Vonage's fixed frame size
const FRAMES_PER_SEC = 50;           // 1000 ms / 20 ms

// ─── Echo-test behaviour ───
// We collect up to 5 seconds of caller audio, then (on silence) replay it.
const MAX_CAPTURE_FRAMES = FRAMES_PER_SEC * 5;   // 5 s @ 50 fps
const SILENCE_FRAMES_TO_END = 40;                // 0.8 s of quiet → start replay
const MIN_CAPTURE_FRAMES = 10;                   // 0.2 s — filters coughs
// RMS threshold for "speech". 16-bit PCM ranges -32768..32767. A quiet phone
// line sits around 200-400 RMS; normal speech is 2000+. 800 is a safe gate.
const SILENCE_RMS_THRESHOLD = 800;

/**
 * Compute root-mean-square of a 16-bit PCM frame. Used for silence detection.
 * Reads little-endian int16 samples.
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
 * Per-connection session state. One of these per active call.
 */
class CallSession {
  constructor(ws, log) {
    this.ws = ws;
    this.log = log;
    this.callUuid = null;
    this.framesReceived = 0;
    this.framesSent = 0;
    this.audioStarted = false;      // have we seen any speech yet?
    this.silentFrames = 0;          // consecutive quiet frames
    this.capture = [];              // queued frames during capture phase
    this.playbackTimer = null;      // active setInterval during replay
    this.replayCount = 0;           // how many replays we've done
    this.connectedAt = Date.now();
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
    this.log.info({ event, msg }, `WS text frame: ${event}`);

    if (event === "websocket:connected") {
      // Pick up the call_uuid from the initial handshake headers.
      // These fields are whatever we put in `headers` on the NCCO's connect action.
      this.callUuid = msg.call_uuid ?? msg.callUuid ?? null;
      if (this.callUuid) {
        this.log = forCall(this.callUuid);
        this.log.info(
          { from: msg.from, to: msg.to, contentType: msg["content-type"] },
          "Call audio stream established"
        );
      }
    } else if (event === "websocket:disconnected") {
      this.log.info("Vonage signaled disconnect");
    }
    // Other text events (mute updates, etc.) are logged and ignored.
  }

  handleBinary(chunk) {
    // Vonage promises exactly 640 bytes per frame. Guard against surprises.
    if (chunk.length !== FRAME_BYTES) {
      this.log.warn(
        { length: chunk.length, expected: FRAME_BYTES },
        "Unexpected binary frame size — skipping"
      );
      return;
    }

    this.framesReceived++;

    // Log throughput sparingly (every 1 second of audio = 50 frames).
    if (this.framesReceived % FRAMES_PER_SEC === 0) {
      this.log.debug(
        { framesReceived: this.framesReceived },
        `Received ${this.framesReceived / FRAMES_PER_SEC}s of audio`
      );
    }

    // Don't capture while we're replaying — the caller shouldn't hear
    // themselves mid-replay re-entering the buffer.
    if (this.playbackTimer) return;

    const rms = frameRms(chunk);
    const isSpeech = rms >= SILENCE_RMS_THRESHOLD;

    if (isSpeech) {
      if (!this.audioStarted) {
        this.log.info({ rms: Math.round(rms) }, "Speech start detected");
        this.audioStarted = true;
      }
      this.capture.push(chunk);
      this.silentFrames = 0;

      // Cap at 5s to prevent runaway memory use
      if (this.capture.length >= MAX_CAPTURE_FRAMES) {
        this.log.info("Max capture reached — forcing replay");
        this.startReplay();
      }
    } else if (this.audioStarted) {
      // Already in a capture — accumulate trailing silence so replay sounds natural
      this.capture.push(chunk);
      this.silentFrames++;
      if (
        this.silentFrames >= SILENCE_FRAMES_TO_END &&
        this.capture.length >= MIN_CAPTURE_FRAMES
      ) {
        this.log.info(
          {
            capturedFrames: this.capture.length,
            capturedMs: this.capture.length * 20,
          },
          "End of utterance — starting replay"
        );
        this.startReplay();
      }
    }
    // else: still waiting for the caller to speak; drop the frame.
  }

  startReplay() {
    if (this.playbackTimer) return; // already replaying
    if (this.capture.length === 0) return;

    this.replayCount++;
    const toReplay = this.capture.slice();
    this.capture = [];
    this.audioStarted = false;
    this.silentFrames = 0;
    let idx = 0;

    this.log.info(
      { frames: toReplay.length, ms: toReplay.length * 20 },
      `Replay #${this.replayCount} starting`
    );

    // Pace playback at 50 fps — exactly real-time. Faster and Vonage buffers;
    // slower and the caller hears stutters.
    this.playbackTimer = setInterval(() => {
      if (this.ws.readyState !== 1 /* OPEN */) {
        this.log.warn("WS closed during playback — stopping");
        this.stopReplay();
        return;
      }
      if (idx >= toReplay.length) {
        this.log.info({ sent: this.framesSent }, "Replay complete — listening again");
        this.stopReplay();
        return;
      }
      try {
        this.ws.send(toReplay[idx]);
        this.framesSent++;
        idx++;
      } catch (err) {
        this.log.error({ err: err.message }, "Send failed during playback");
        this.stopReplay();
      }
    }, 20); // 20 ms cadence = 50 fps
  }

  stopReplay() {
    if (this.playbackTimer) {
      clearInterval(this.playbackTimer);
      this.playbackTimer = null;
    }
  }

  handleClose(code, reason) {
    this.stopReplay();
    const durationMs = Date.now() - this.connectedAt;
    this.log.info(
      {
        code,
        reason: reason?.toString() ?? "",
        durationMs,
        framesReceived: this.framesReceived,
        framesSent: this.framesSent,
        replays: this.replayCount,
      },
      "Call WebSocket closed"
    );
  }

  handleError(err) {
    this.log.error({ err: err.message, stack: err.stack }, "WS error");
    this.stopReplay();
  }
}

/**
 * Attach a WebSocket server to the given HTTP server on /ws/voice.
 */
export function attachWebSocketServer(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");

    if (url.pathname !== "/ws/voice") {
      logger.warn({ path: url.pathname }, "Rejecting WS upgrade for unknown path");
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (ws, request) => {
    // We won't know the real call_uuid until Vonage sends the first text frame.
    // Until then, log under a connection id.
    const connId = `conn-${Date.now().toString(36)}-${Math.floor(
      Math.random() * 1000
    )
      .toString(36)
      .padStart(3, "0")}`;
    const log = logger.child({ conn_id: connId });

    log.info(
      {
        remoteAddress: request.socket.remoteAddress,
        headers: {
          host: request.headers.host,
          userAgent: request.headers["user-agent"],
        },
      },
      "Vonage WebSocket connected"
    );

    const session = new CallSession(ws, log);

    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        // ws gives us a Buffer for binary frames.
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
