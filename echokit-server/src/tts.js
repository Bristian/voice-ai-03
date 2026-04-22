/**
 * OpenAI TTS — streaming text-to-speech, output as 16kHz PCM.
 *
 * Uses OpenAI's audio/speech endpoint with response_format=pcm to get
 * raw 24kHz 16-bit mono PCM. We downsample to 16kHz to match Vonage's
 * expected format, then chunk into 640-byte frames (20ms each).
 *
 * The streaming approach means the caller starts hearing audio within
 * ~200ms of the TTS request, rather than waiting for the full response
 * to generate.
 */

import { config } from "./config.js";
import { logger } from "./logger.js";

const TTS_URL = "https://api.openai.com/v1/audio/speech";

/**
 * Stream TTS audio for the given text.
 *
 * Calls the onFrame callback with 640-byte PCM buffers at 16kHz as they
 * become available. Calls onDone when finished.
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

  try {
    // OpenAI TTS with pcm output gives us raw 24kHz 16-bit mono PCM.
    // We request pcm format and will downsample from 24kHz to 16kHz.
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

    // Stream the response body and process chunks
    const reader = response.body.getReader();
    let leftover = Buffer.alloc(0);  // partial frame buffer

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      // Concatenate with any leftover bytes from previous chunk
      const raw24k = Buffer.concat([leftover, Buffer.from(value)]);

      // Downsample from 24kHz to 16kHz (take every 3rd sample pair out of each 3,
      // effectively: keep 2 out of every 3 samples)
      // More precisely: 24000/16000 = 3/2, so for every 3 input samples, output 2.
      const downsampled = downsample24to16(raw24k);

      // Chunk into 640-byte frames (20ms at 16kHz)
      let offset = 0;
      while (offset + 640 <= downsampled.output.length) {
        const frame = downsampled.output.subarray(offset, offset + 640);
        if (!firstFrameSent) {
          firstFrameSent = true;
          log.info({ latencyMs: Date.now() - t0 }, "TTS first frame");
        }
        onFrame(Buffer.from(frame));
        offset += 640;
      }

      // Keep any leftover bytes that didn't form a complete input cycle
      // We need to account for leftover from the downsampler too
      leftover = downsampled.remainder;
    }

    const elapsed = Date.now() - t0;
    log.info({ elapsedMs: elapsed }, "TTS complete");
    onDone?.();
  } catch (err) {
    log.error({ err: err.message }, "TTS error");
    onError?.(err);
  }
}

/**
 * Downsample 24kHz 16-bit PCM to 16kHz using linear interpolation.
 *
 * Ratio: 24000/16000 = 3/2. For every 3 input samples, we produce 2 output samples.
 * We use simple linear interpolation for quality.
 *
 * Returns { output: Buffer, remainder: Buffer } where remainder is the
 * unconsumed input bytes (0-5 bytes that didn't form a complete 3-sample group).
 */
function downsample24to16(inputBuf) {
  const bytesPerSample = 2;
  const totalSamples = Math.floor(inputBuf.length / bytesPerSample);

  // Process in groups of 3 input samples → 2 output samples
  const groups = Math.floor(totalSamples / 3);
  const consumedBytes = groups * 3 * bytesPerSample;
  const remainder = inputBuf.subarray(consumedBytes);

  const outputBuf = Buffer.alloc(groups * 2 * bytesPerSample);
  let outIdx = 0;

  for (let g = 0; g < groups; g++) {
    const base = g * 3 * bytesPerSample;
    const s0 = inputBuf.readInt16LE(base);
    const s1 = inputBuf.readInt16LE(base + 2);
    const s2 = inputBuf.readInt16LE(base + 4);

    // Output sample 0: interpolate at position 0 (= s0)
    outputBuf.writeInt16LE(s0, outIdx);
    outIdx += 2;

    // Output sample 1: interpolate at position 1.5 (between s1 and s2)
    const interp = Math.round((s1 + s2) / 2);
    outputBuf.writeInt16LE(Math.max(-32768, Math.min(32767, interp)), outIdx);
    outIdx += 2;
  }

  return { output: outputBuf, remainder };
}
