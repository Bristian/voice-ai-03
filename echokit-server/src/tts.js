/**
 * OpenAI TTS — streaming text-to-speech with in-memory audio cache.
 *
 * Slice 4 additions:
 *   - In-memory LRU cache for TTS audio. Identical response texts (greetings,
 *     common FAQ answers, disclaimers) are cached as arrays of 640-byte PCM frames.
 *     Cache hits skip the OpenAI API call entirely — ~0ms vs ~2000ms.
 *   - Cache is keyed by sha256(text), max 50 entries (~50 * 5s * 32KB/s ≈ 8MB).
 *
 * Audio format: OpenAI outputs 24kHz 16-bit mono PCM. We downsample to 16kHz
 * using 3:2 linear interpolation and chunk into 640-byte frames for Vonage.
 */

import crypto from "node:crypto";
import { config } from "./config.js";
import { logger } from "./logger.js";

const TTS_URL = "https://api.openai.com/v1/audio/speech";

// ─── In-memory TTS cache ───
// Map<sha256(text), Buffer[]>  — array of 640-byte PCM frames
const _cache = new Map();
const CACHE_MAX_ENTRIES = 50;

function cacheKey(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function cacheGet(text) {
  const key = cacheKey(text);
  const frames = _cache.get(key);
  if (frames) {
    // Move to end (LRU)
    _cache.delete(key);
    _cache.set(key, frames);
    return frames;
  }
  return null;
}

function cacheSet(text, frames) {
  const key = cacheKey(text);
  // Evict oldest if at capacity
  if (_cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = _cache.keys().next().value;
    _cache.delete(oldest);
  }
  _cache.set(key, frames);
}

/** Get current cache stats for logging. */
export function ttsCacheStats() {
  return { entries: _cache.size, maxEntries: CACHE_MAX_ENTRIES };
}

/**
 * Stream TTS audio for the given text, with cache.
 *
 * @param {string} text - The text to speak
 * @param {object} opts
 * @param {function(Buffer): void} opts.onFrame - Called with each 640-byte PCM frame
 * @param {function(): void} opts.onDone - Called when all audio has been delivered
 * @param {function(Error): void} opts.onError - Called on error
 * @param {object} [opts.log] - Pino logger instance
 */
export async function streamTts(text, { onFrame, onDone, onError, log: callLog }) {
  const log = callLog ?? logger;

  if (!config.OPENAI_API_KEY) {
    onError?.(new Error("OPENAI_API_KEY not configured"));
    return;
  }

  // ── Cache check ──
  const cached = cacheGet(text);
  if (cached) {
    log.info({ textLen: text.length, frames: cached.length, source: "cache" }, "TTS cache HIT");
    for (const frame of cached) {
      onFrame(frame);
    }
    onDone?.();
    return;
  }

  log.info({ textLen: text.length }, "TTS cache MISS — calling OpenAI");
  const t0 = Date.now();
  let firstFrameSent = false;
  let totalFrames = 0;
  const collectedFrames = []; // Collect for caching

  try {
    const response = await fetch(TTS_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "tts-1",
        input: text,
        voice: "nova",
        response_format: "pcm",
        speed: 0.95,
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`OpenAI TTS HTTP ${response.status}: ${errText.slice(0, 200)}`);
    }

    const reader = response.body.getReader();
    let pending = Buffer.alloc(0);
    let frameBuffer = Buffer.alloc(0);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      pending = Buffer.concat([pending, Buffer.from(value)]);

      const BYTES_PER_GROUP_IN = 6;
      const BYTES_PER_GROUP_OUT = 4;

      const groupCount = Math.floor(pending.length / BYTES_PER_GROUP_IN);
      if (groupCount === 0) continue;

      const consumeBytes = groupCount * BYTES_PER_GROUP_IN;
      const outBytes = groupCount * BYTES_PER_GROUP_OUT;
      const outBuf = Buffer.alloc(outBytes);
      let outOff = 0;

      for (let g = 0; g < groupCount; g++) {
        const base = g * BYTES_PER_GROUP_IN;
        const s0 = pending.readInt16LE(base);
        const s1 = pending.readInt16LE(base + 2);
        const s2 = pending.readInt16LE(base + 4);

        outBuf.writeInt16LE(s0, outOff);
        outOff += 2;

        const interp = Math.round((s1 + s2) / 2);
        outBuf.writeInt16LE(Math.max(-32768, Math.min(32767, interp)), outOff);
        outOff += 2;
      }

      pending = pending.subarray(consumeBytes);
      frameBuffer = Buffer.concat([frameBuffer, outBuf]);

      while (frameBuffer.length >= 640) {
        const frame = Buffer.from(frameBuffer.subarray(0, 640));
        frameBuffer = frameBuffer.subarray(640);

        if (!firstFrameSent) {
          firstFrameSent = true;
          log.info({ latencyMs: Date.now() - t0 }, "TTS first frame");
        }

        onFrame(frame);
        collectedFrames.push(frame);
        totalFrames++;
      }
    }

    // Flush partial frame
    if (frameBuffer.length > 0) {
      const padded = Buffer.alloc(640);
      frameBuffer.copy(padded);
      onFrame(padded);
      collectedFrames.push(padded);
      totalFrames++;
    }

    // Store in cache for next time
    cacheSet(text, collectedFrames);
    const stats = ttsCacheStats();

    log.info(
      { elapsedMs: Date.now() - t0, totalFrames, cacheEntries: stats.entries },
      "TTS complete (cached for future)"
    );
    onDone?.();
  } catch (err) {
    log.error({ err: err.message }, "TTS error");
    onError?.(err);
  }
}
