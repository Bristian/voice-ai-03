# echokit-server

Real-time WebSocket audio orchestrator. The bridge between Vonage Voice API and the AI stack.

**Slice 1 scope:** webhooks + audio echo. No STT/LLM/TTS yet.

## What it does (slice 1)

1. Accepts Vonage webhooks at `/webhooks/answer`, `/webhooks/events`, `/webhooks/fallback`
2. Returns an NCCO that plays a greeting (Vonage built-in TTS) then opens a WebSocket
3. Accepts Vonage's WebSocket audio at `/ws/voice` (16kHz mono 16-bit PCM, 640-byte frames)
4. Detects when the caller has spoken and stopped (simple RMS-based voice detection)
5. Replays the captured audio back to the caller — proves the audio pipe works in both directions

## Run locally

```bash
# From repo root
npm install

# Start the server
cd echokit-server
cp .env.example .env
# Edit .env — set PUBLIC_URL to your ngrok URL or similar
npm run dev
```

Hit `http://localhost:3000/healthz` to confirm it's alive.

## Deploy to Railway

See `SLICE-1-SETUP.md` at the repo root for the full walkthrough including Vonage account setup.

## Environment variables

See `.env.example`. The only required var is `PUBLIC_URL` — the publicly reachable HTTPS URL where Vonage can send webhooks.

## File layout

```
src/
├── server.js              # Main entry — HTTP + WS wire-up
├── config.js              # Env var loader + Zod validation
├── logger.js              # Pino structured JSON logger
├── webhooks.js            # Vonage webhook routes (answer/events/fallback)
├── websocket.js           # /ws/voice audio server + echo implementation
├── health.js              # /healthz + GET / for humans
└── vonage-signature.js    # Optional JWT/HS256 webhook verification
```

## Protocol notes

Vonage's WebSocket audio format is surprising enough to call out:

- **Frame size is 640 bytes at 16kHz** (20ms × 16000 samples/sec × 2 bytes/sample). The original architecture doc said 320 — that's the 8kHz size.
- **First frame is TEXT** (`event: websocket:connected` with metadata). Subsequent frames are binary PCM.
- **Same format both directions**: we write 640-byte PCM chunks back to Vonage at 50 fps real-time pacing. Faster → Vonage buffers. Slower → caller hears stutter.
- **Vonage webhook signatures are JWT-based** (Authorization: Bearer, HS256), with the secret being **base64-encoded** — you must `Buffer.from(secret, 'base64')` before verification.
