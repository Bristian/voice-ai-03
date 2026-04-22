/**
 * OpenAI TTS — streaming text-to-speech, output as 16kHz PCM for Vonage.
 *
 * OpenAI's /v1/audio/speech endpoint with response_format=pcm outputs
 * raw 24kHz 16-bit signed LE mono PCM (no header). We must downsample
 * to 16kHz for Vonage.
 *
 * The downsampling uses a simple "drop every 3rd sample" approach
 * (decimation by 3/2) which is the correct ratio for 24000 → 16000.
 * Every 3 input samples produce 2 output samples via linear interpolation.
 *
 * The output is chunked into exactly 640-byte frames (20ms at 16kHz).
 */

import { config } from "./config.js";
import { logger } from "./logger.js";

const TTS_URL = "https://api.openai.com/v1/audio/speech";

/**
 * Stream TTS audio for the given text.
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

  log.info({ textLen: text.length }, "TTS starting");
  const t0 = Date.now();
  let firstFrameSent = false;
  let totalFrames = 0;

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
        response_format: "pcm",  // raw 24kHz 16-bit mono PCM
        speed: 0.95,
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`OpenAI TTS HTTP ${response.status}: ${errText.slice(0, 200)}`);
    }

    const reader = response.body.getReader();

    // Accumulator for raw 24kHz bytes that haven't been processed yet.
    // We need complete sample-pairs (2 bytes each) in groups of 3 for downsampling.
    let pending = Buffer.alloc(0);

    // Accumulator for 16kHz output bytes waiting to fill a 640-byte frame.
    let frameBuffer = Buffer.alloc(0);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Append new data to pending
      pending = Buffer.concat([pending, Buffer.from(value)]);

      // Downsample: consume groups of 6 bytes (3 samples at 24kHz) → produce
      // 4 bytes (2 samples at 16kHz). This is the 3:2 ratio.
      const BYTES_PER_GROUP_IN = 6;   // 3 samples × 2 bytes
      const BYTES_PER_GROUP_OUT = 4;  // 2 samples × 2 bytes

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

        // Output sample 0: take s0 directly
        outBuf.writeInt16LE(s0, outOff);
        outOff += 2;

        // Output sample 1: linear interpolation between s1 and s2
        const interp = Math.round((s1 + s2) / 2);
        outBuf.writeInt16LE(Math.max(-32768, Math.min(32767, interp)), outOff);
        outOff += 2;
      }

      // Keep unconsumed bytes
      pending = pending.subarray(consumeBytes);

      // Append downsampled audio to frame buffer
      frameBuffer = Buffer.concat([frameBuffer, outBuf]);

      // Emit complete 640-byte frames
      while (frameBuffer.length >= 640) {
        const frame = frameBuffer.subarray(0, 640);
        frameBuffer = frameBuffer.subarray(640);

        if (!firstFrameSent) {
          firstFrameSent = true;
          log.info({ latencyMs: Date.now() - t0 }, "TTS first frame");
        }

        onFrame(Buffer.from(frame));
        totalFrames++;
      }
    }

    // Flush any remaining partial frame as silence-padded
    if (frameBuffer.length > 0) {
      const padded = Buffer.alloc(640);
      frameBuffer.copy(padded);
      onFrame(padded);
      totalFrames++;
    }

    log.info({ elapsedMs: Date.now() - t0, totalFrames }, "TTS complete");
    onDone?.();
  } catch (err) {
    log.error({ err: err.message }, "TTS error");
    onError?.(err);
  }
}
