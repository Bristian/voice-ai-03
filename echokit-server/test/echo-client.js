/**
 * WebSocket echo test — simulates what Vonage does.
 *
 * 1. Connects to ws://localhost:3000/ws/voice
 * 2. Sends the initial text handshake (websocket:connected)
 * 3. Streams 2 seconds of "speech" (a 440Hz sine wave at speaking volume)
 * 4. Then 1.5 seconds of silence (so the server detects end-of-utterance)
 * 5. Counts binary frames received back — we expect ~100 frames of echoed audio
 */

import { WebSocket } from "ws";

const FRAME_SAMPLES = 320;
const FRAME_BYTES = FRAME_SAMPLES * 2;
const SAMPLE_RATE = 16000;

function makeSineFrame(freqHz, phaseStart, amplitude) {
  const buf = Buffer.alloc(FRAME_BYTES);
  for (let i = 0; i < FRAME_SAMPLES; i++) {
    const t = (phaseStart + i) / SAMPLE_RATE;
    const sample = Math.round(Math.sin(2 * Math.PI * freqHz * t) * amplitude);
    buf.writeInt16LE(sample, i * 2);
  }
  return buf;
}

function makeSilenceFrame() {
  return Buffer.alloc(FRAME_BYTES); // all zeros
}

async function run() {
  const url = process.env.WS_URL ?? "ws://localhost:3000/ws/voice";
  console.log(`Connecting to ${url}...`);
  const ws = new WebSocket(url);

  const received = { text: 0, binary: 0 };

  ws.on("open", async () => {
    console.log("✓ Connected");

    // Step 1: handshake text frame (mimics Vonage)
    ws.send(
      JSON.stringify({
        "content-type": "audio/l16;rate=16000",
        event: "websocket:connected",
        call_uuid: "test-echo-abc123",
        from: "+15551234567",
        to: "+15559999999",
      })
    );
    console.log("✓ Sent handshake");

    // Step 2: 2 seconds of speech (100 frames @ 50fps)
    console.log("▸ Streaming 2s of tone at ~8000 amplitude (speech-like RMS)…");
    let phase = 0;
    for (let i = 0; i < 100; i++) {
      ws.send(makeSineFrame(440, phase, 8000));
      phase += FRAME_SAMPLES;
      await new Promise((r) => setTimeout(r, 20));
    }

    // Step 3: 1.5s of silence (75 frames) — triggers end-of-utterance
    console.log("▸ Streaming 1.5s of silence (should trigger replay)…");
    for (let i = 0; i < 75; i++) {
      ws.send(makeSilenceFrame());
      await new Promise((r) => setTimeout(r, 20));
    }

    // Step 4: wait for replay to finish (replay is paced at 20ms/frame so up to ~3.5s)
    console.log("▸ Waiting 4s for replay…");
    await new Promise((r) => setTimeout(r, 4000));

    ws.close(1000, "test_done");
  });

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      received.binary++;
      if (received.binary === 1) console.log("✓ First echoed binary frame received");
    } else {
      received.text++;
      console.log(`✓ Text frame: ${data.toString().slice(0, 100)}`);
    }
  });

  ws.on("close", (code, reason) => {
    console.log(`\n✓ Closed: code=${code} reason=${reason?.toString() ?? ""}`);
    console.log(`  Frames received — binary: ${received.binary}, text: ${received.text}`);
    const ok = received.binary >= 50;  // should see at least 1s of echo
    console.log(ok ? "\n✅ PASS" : "\n❌ FAIL — expected ≥50 binary frames back");
    process.exit(ok ? 0 : 1);
  });

  ws.on("error", (err) => {
    console.error("✗ Error:", err.message);
    process.exit(2);
  });
}

run();
