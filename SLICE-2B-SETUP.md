# Slice 2b — Wire the Audio Pipeline (STT + TTS + Agent)

**Goal:** call your Vonage number and have a real conversation about cars. The AI listens via ElevenLabs STT, thinks via agent-api (GPT-4o), and speaks back via OpenAI TTS.

**What this proves:** the full end-to-end voice AI pipeline — telephony → speech recognition → AI reasoning → speech synthesis → telephony.

**Time estimate:** 15–20 minutes (mostly setting environment variables).

**What you need:**
- Slices 1 + 2a working (echokit-server + agent-api both deployed on Railway)
- An **ElevenLabs API key** — sign up at https://elevenlabs.io, get your key from Settings → API Keys. The free tier works for testing.
- Your **OpenAI API key** (same one agent-api already uses)

---

## What changed in this slice

Only `echokit-server` changed — no agent-api modifications needed.

**New files:**
- `src/stt.js` — ElevenLabs Realtime STT WebSocket client with auto-reconnect between turns
- `src/tts.js` — OpenAI TTS streaming with 24kHz → 16kHz downsampling (accumulator-based, no audio artifacts)
- `src/agent-client.js` — HTTP client for agent-api `/v1/agent/turn`

**Modified files:**
- `src/config.js` — added `AGENT_API_URL`, `ELEVENLABS_API_KEY`, `OPENAI_API_KEY`, VAD tuning vars
- `src/websocket.js` — replaced echo logic with: VAD → STT → agent → TTS → Vonage

**Key implementation details:**

- **STT auto-reconnect:** ElevenLabs closes the WebSocket after delivering a committed transcript. The STT session automatically reconnects after 200ms so multi-turn conversations work. A `manualClose` flag prevents reconnection when the call ends normally.

- **TTS downsampling:** OpenAI TTS outputs 24kHz PCM. We downsample to 16kHz (Vonage's format) using a 3:2 ratio — every 3 input samples produce 2 output samples via linear interpolation. The downsampler accumulates bytes and only emits complete 640-byte frames to avoid audio artifacts.

- **Barge-in:** if the caller speaks while TTS is playing, the playback is immediately canceled and the new utterance is processed.

**Backward compatible:** if the API keys aren't set, echokit-server falls back to echo mode (slice 1 behavior). This means your existing deployment still works while you configure the new variables.

---

## 1. Upload the code to GitHub

```bash
cd your-local-repo
git add -A
git commit -m "slice 2b: wire audio pipeline — STT + TTS + agent"
git push
```

---

## 2. Get an ElevenLabs API key

1. Go to https://elevenlabs.io and sign up (or log in)
2. Click your profile icon → **Settings** → **API Keys**
3. Copy your API key

The free tier gives you enough credits for testing. Each call uses a small amount of STT credits per second of audio.

---

## 3. Set environment variables on echokit-server

Go to Railway → your `echokit-server` service → **Variables** tab.

Add or update these variables:

| Variable | Value |
|---|---|
| `AGENT_API_URL` | The public URL of your agent-api service — copy it from agent-api's service tile (something like `https://agent-api-production-xxxx.up.railway.app`) |
| `ELEVENLABS_API_KEY` | Your ElevenLabs API key |
| `OPENAI_API_KEY` | Your OpenAI API key (same one agent-api uses) |
| `GREETING_TEXT` | `Hello, thanks for calling the dealership. How can I help you today?` |

Leave everything else as-is (`PUBLIC_URL`, `PORT`, etc. should already be set from slice 1).

> **Finding the agent-api URL:** click the `agent-api` tile on Railway → the domain is shown at the top of the tile. Copy the full `https://...` URL.

Railway auto-redeploys echokit-server when you change variables.

---

## 4. Verify the deployment

Watch the **Deployments** tab for echokit-server. In the deploy logs you should see:

```
echokit-server listening
    port: 8080
    publicUrl: "https://..."
    wsUrl: "wss://..."
    signatureVerification: "disabled"
```

The log should NOT show `AI pipeline disabled` — if it does, one of the API keys isn't set correctly.

Check `/healthz` in your browser to confirm the service is alive.

---

## 5. Place the test call — the moment of truth

1. Open Railway logs for echokit-server (Deployments tab → active deployment → View Logs)
2. Dial your Vonage number from your cell phone
3. You'll hear the greeting: *"Hello, thanks for calling the dealership. How can I help you today?"*
4. After the greeting, **wait about 1 second**, then ask something like:

   > "Do you have any Toyota SUVs?"

5. Wait a few seconds. You should hear the AI respond with available Toyotas from your inventory.
6. Try a follow-up:

   > "What about something under thirty thousand?"

7. The AI should narrow the results based on the accumulated context.

> **Note on latency:** the first call after a deploy may take 5-10 seconds to respond because agent-api needs to "warm up" (establish database connections, load models). Subsequent calls within the same session and future calls should be faster (2-4 seconds).

### Other things to try

- **FAQ question:** *"What are your business hours?"*
- **Financing:** *"Do you offer financing?"*
- **Specific vehicle:** *"Do you have any hybrid SUVs?"*
- **Transfer:** *"Can I talk to a person?"* (the AI will say it's transferring — actual transfer not wired yet)
- **Barge-in:** start speaking while the AI is mid-response — it should stop talking and listen to you

---

## 6. What to expect in the logs

A successful multi-turn call shows this sequence:

```
INFO  Answer webhook received
INFO  Call event: ringing
INFO  Call event: answered
INFO  Vonage WebSocket connected
INFO  Call audio stream established (aiPipeline: true)
INFO  ElevenLabs STT WebSocket connected
INFO  STT session started

--- Turn 1 ---
INFO  Speech start (rms: 1093)
INFO  End of utterance — committing STT (speechMs: 1520)
INFO  STT committed transcript (text: "Do you have any Toyota SUVs?")
INFO  Processing turn (turn: 1)
INFO  Calling agent-api
INFO  Agent turn complete (intent: availability_check, elapsedMs: 9135)
INFO  TTS starting (textLen: 193)
INFO  TTS first frame (latencyMs: 2666)
INFO  TTS complete (elapsedMs: 3850)
INFO  STT WebSocket closed
INFO  TTS playback complete (framesSent: 240)

--- STT auto-reconnects for turn 2 ---
INFO  STT auto-reconnecting…
INFO  ElevenLabs STT WebSocket connected
INFO  STT session started

--- Turn 2 ---
INFO  Speech start (rms: 1756)
INFO  End of utterance — committing STT (speechMs: 1440)
INFO  STT committed transcript (text: "What about under thirty thousand?")
INFO  Processing turn (turn: 2)
INFO  Calling agent-api
INFO  Agent turn complete (intent: vehicle_search, elapsedMs: ...)
INFO  TTS starting ...
...

--- Call ends ---
INFO  Call WebSocket closed (turns: 2, mode: ai)
INFO  Call event: completed (duration: 69)
```

Key things to look for:
- `aiPipeline: true` — confirms the AI keys are configured
- `STT auto-reconnecting…` — this appears between turns; it's normal and expected
- `STT committed transcript` — this is what the AI heard you say
- `Agent turn complete` — shows intent, latency, and vehicle count
- `TTS first frame (latencyMs)` — time from agent response to first audio frame sent to caller

---

## 7. Troubleshooting

### "I hear the greeting but then silence"

The AI pipeline isn't connecting. Check:
1. Railway deploy logs — look for `AI pipeline disabled`. If present, one of the three env vars (`AGENT_API_URL`, `ELEVENLABS_API_KEY`, `OPENAI_API_KEY`) isn't set.
2. Look for `ElevenLabs STT WebSocket connected` — if missing, `ELEVENLABS_API_KEY` is wrong.
3. Look for `Calling agent-api` — if missing, STT never produced a transcript. Try speaking louder and waiting longer after you stop.
4. Look for `Agent turn failed` — if present, `AGENT_API_URL` is wrong or agent-api is down. Test agent-api's `/healthz` directly in your browser.

### "The AI response sounds garbled, robotic, or broken up"

This was an issue in an earlier version caused by incorrect audio downsampling. Make sure you have the latest code (the version with the accumulator-based downsampler in `tts.js`). If you still hear artifacts:
1. Check the logs for `TTS complete (totalFrames: N)` — if N is very low (under 50 for a normal sentence), the TTS may be producing truncated audio.
2. Try a shorter prompt by asking a simple question like *"hello"* — if short responses sound fine but long ones break up, it may be a network throughput issue on Railway's free tier.

### "The first question works but follow-ups get no response"

This was an issue in an earlier version where the ElevenLabs STT WebSocket closed after the first transcript and didn't reconnect. Make sure you have the latest code with `STT auto-reconnecting…` logic in `stt.js`. After deploying the fix, you should see in the logs:

```
INFO  STT WebSocket closed
INFO  STT auto-reconnecting…
INFO  ElevenLabs STT WebSocket connected
INFO  STT session started
```

If you see `STT WebSocket closed` but NOT `STT auto-reconnecting…`, you're running the old code. Push the latest zip to GitHub.

### "The AI takes too long to respond (5+ seconds)"

Normal for the first call after a deploy — agent-api needs to "warm up" (establish database connections, first OpenAI API call). Subsequent calls should be 2-4 seconds. If consistently slow:
1. Check agent-api logs for which stage is slow (`intent_ms`, `rag_ms`, `sql_ms`, `synthesis_ms` in the response)
2. The biggest contributor is usually the LLM synthesis (GPT-4o, ~400-700ms) plus the intent classification (GPT-4o-mini, ~150ms). These run sequentially.
3. To reduce latency: in `agent-api/app/config.py`, change `synthesis_model` from `gpt-4o` to `gpt-4o-mini` — faster but slightly lower quality responses.

### "The AI doesn't hear me / Speech start never appears in logs"

The VAD threshold might be too high for your phone's audio quality:
1. Add `SILENCE_RMS_THRESHOLD=500` to echokit-server variables (lower = more sensitive)
2. Or try `SILENCE_RMS_THRESHOLD=400` for very quiet phone lines
3. Redeploy and try again

### "The AI cuts me off before I finish speaking"

The silence detection triggers end-of-utterance too quickly:
1. Add `SILENCE_FRAMES=60` to echokit-server variables (60 frames = 1.2 seconds of silence before end-of-utterance)
2. Default is 40 (0.8 seconds). Try 50 or 60 if you speak with natural pauses.

### "I'm still hearing echo instead of the AI"

The deploy didn't pick up the new code, or API keys are empty. Check:
1. GitHub — does the repo contain `src/stt.js`, `src/tts.js`, `src/agent-client.js`?
2. Railway — is the deployment status "Active" (green)? Check build logs for errors.
3. Verify `ELEVENLABS_API_KEY` and `OPENAI_API_KEY` are set and non-empty in the Variables tab.
4. Look for `AI pipeline disabled` in deploy logs — if present, the keys aren't reaching the service.

### "Barge-in doesn't work"

Barge-in (speaking over the AI to interrupt) should work automatically. If the AI keeps talking over you:
1. This can happen if the VAD threshold is too high — lower `SILENCE_RMS_THRESHOLD`
2. Check logs for `Barge-in detected — canceling TTS` — if it never appears, the threshold is the issue
3. Barge-in only works while TTS audio is actively being sent (during `TTS starting` → `TTS playback complete`)

### "vehicleCount: 0 in the agent turn response"

The agent-api found no matching vehicles. Possible causes:
1. The seed data doesn't match your query — check what vehicles are in the database (`SELECT make, model, body_style FROM vehicles;` in Railway SQL console)
2. The intent was classified as something other than `vehicle_search` — check the `intent` field in the log. FAQ-type intents don't search the vehicles table.

---

## 8. How the audio pipeline works (for reference)

```
Caller speaks → Vonage → 640-byte PCM frames (16kHz) → echokit-server
                                                            │
                                                            ├─ RMS VAD detects speech start/end
                                                            │
                                                            ├─ During speech: frames streamed to
                                                            │   ElevenLabs STT (WebSocket, base64)
                                                            │   └─ Returns partial + committed transcripts
                                                            │
                                                            ├─ On silence → commit STT → get final text
                                                            │
                                                            ├─ POST /v1/agent/turn to agent-api
                                                            │   ├─ Intent classification (GPT-4o-mini)
                                                            │   ├─ Parallel: RAG search + SQL search
                                                            │   └─ Synthesis (GPT-4o) → response text
                                                            │
                                                            ├─ Response text → OpenAI TTS (streaming HTTP)
                                                            │   └─ 24kHz PCM → downsample 3:2 → 16kHz
                                                            │   └─ Accumulate into 640-byte frames
                                                            │
                                                            ├─ 640-byte PCM frames → Vonage → Caller hears AI
                                                            │
                                                            ├─ STT WebSocket closes after committed transcript
                                                            │   └─ Auto-reconnects in 200ms for next turn
                                                            │
                                                            └─ If caller speaks during TTS → barge-in
                                                                └─ Cancel TTS, process new utterance
```

---

## How to know slice 2b is "done"

- [ ] echokit-server is deployed with all three API keys set
- [ ] Deploy logs show AI pipeline is enabled (no "disabled" warning)
- [ ] Calling your Vonage number: you hear the greeting
- [ ] You ask about vehicles and hear a **clear, understandable** response mentioning cars from your inventory
- [ ] You ask a follow-up and the AI uses context from the previous turn (STT auto-reconnect works)
- [ ] FAQ questions ("what are your hours?") return correct answers
- [ ] Barge-in works (speaking over the AI interrupts the response)

**Congratulations — you have a working voice AI agent for a car dealership.**

---

## What's next

| Slice | Goal |
|---|---|
| 3 | Voice-to-SQL refinement + more vehicle query patterns |
| 4 | Silero VAD (neural, replaces RMS) + fine-tuning |
| 5 | Supervisor dashboard + WebRTC listen-in |
| 6 | Hardening — call recording, rate limiting, observability, cross-encoder reranker |

Reply **"slice 3"** when you're ready to continue.
