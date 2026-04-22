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
- `src/stt.js` — ElevenLabs Realtime STT WebSocket client
- `src/tts.js` — OpenAI TTS streaming with 24kHz → 16kHz downsampling
- `src/agent-client.js` — HTTP client for agent-api `/v1/agent/turn`

**Modified files:**
- `src/config.js` — added `AGENT_API_URL`, `ELEVENLABS_API_KEY`, `OPENAI_API_KEY`, VAD tuning vars
- `src/websocket.js` — replaced echo logic with: VAD → STT → agent → TTS → Vonage

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
| `AGENT_API_URL` | The **internal** URL of your agent-api service — copy it from agent-api's service tile (something like `https://agent-api-production-xxxx.up.railway.app`) |
| `ELEVENLABS_API_KEY` | Your ElevenLabs API key |
| `OPENAI_API_KEY` | Your OpenAI API key (same one agent-api uses) |
| `GREETING_TEXT` | `Hello, thanks for calling the dealership. How can I help you today?` |

Leave everything else as-is (`PUBLIC_URL`, `PORT`, etc. should already be set from slice 1).

> **Finding the agent-api internal URL:** click the `agent-api` tile on Railway → look at the domain shown at the top (the public URL). Use that. If you set up Railway's internal networking, you could use the private URL for lower latency, but the public URL works fine.

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

5. Wait ~2-3 seconds. You should hear the AI respond with available Toyotas from your inventory.
6. Try a follow-up:

   > "What about something under thirty thousand?"

7. The AI should narrow the results based on the accumulated context.

### Other things to try

- **FAQ question:** *"What are your business hours?"*
- **Financing:** *"Do you offer financing?"*
- **Specific vehicle:** *"Do you have any hybrid SUVs?"*
- **Transfer:** *"Can I talk to a person?"* (the AI will say it's transferring — actual transfer not wired yet)

---

## 6. What to expect in the logs

A successful call shows this sequence:

```
INFO  Answer webhook received
INFO  Call event: ringing
INFO  Call event: answered
INFO  Vonage WebSocket connected
INFO  Call audio stream established (aiPipeline: true)
INFO  ElevenLabs STT WebSocket connected
INFO  STT session started
INFO  Speech start (rms: 4200)
INFO  End of utterance — committing STT
INFO  STT committed transcript (text: "do you have any Toyota SUVs")
INFO  Calling agent-api
INFO  Agent turn complete (intent: vehicle_search, elapsedMs: 1200)
INFO  TTS starting (textLen: 85)
INFO  TTS first frame (latencyMs: 220)
INFO  TTS playback complete
INFO  Speech start ...        ← caller speaks again
...
INFO  Call WebSocket closed (turns: 3, mode: ai)
```

---

## 7. Troubleshooting

### "I hear the greeting but then silence"

The AI pipeline isn't connecting. Check:
1. Railway deploy logs — look for `AI pipeline disabled`. If present, one of the three env vars isn't set.
2. Look for `ElevenLabs STT WebSocket connected` — if missing, `ELEVENLABS_API_KEY` is wrong.
3. Look for `Calling agent-api` — if missing, STT never produced a transcript. Try speaking louder and waiting longer after you stop.
4. Look for `Agent turn failed` — if present, `AGENT_API_URL` is wrong or agent-api is down. Test agent-api's `/healthz` directly.

### "I hear the greeting, speak, but the AI response is cut off or garbled"

TTS audio format issue. Check:
1. Look for `TTS first frame` in logs — if missing, `OPENAI_API_KEY` is wrong.
2. Look for `TTS error` — usually means the OpenAI key is invalid or out of credits.

### "The AI takes too long to respond (5+ seconds)"

Normal for the first call — the agent-api needs to "warm up" (load models, establish DB connections). Subsequent calls should be faster (2-3 seconds). If consistently slow:
1. Check agent-api logs for which stage is slow (intent_ms, rag_ms, sql_ms, synthesis_ms)
2. The biggest contributor is usually the LLM synthesis (GPT-4o). Consider switching to GPT-4o-mini for synthesis in `agent-api/app/config.py` (`synthesis_model`).

### "The AI doesn't hear me / Speech start never appears"

The VAD threshold might be too high for your phone's audio quality:
1. Add `SILENCE_RMS_THRESHOLD=500` to echokit-server variables (lower = more sensitive)
2. Or try `SILENCE_RMS_THRESHOLD=400`
3. Redeploy and try again

### "The AI cuts me off before I finish speaking"

The silence detection is too aggressive:
1. Add `SILENCE_FRAMES=60` to echokit-server variables (60 frames = 1.2 seconds of silence before end-of-utterance)
2. Default is 40 (0.8 seconds)

### "I'm still hearing echo instead of the AI"

The deploy didn't pick up the new code. Check:
1. GitHub — does the repo contain `src/stt.js`, `src/tts.js`, `src/agent-client.js`?
2. Railway — is the deployment status "Active" (green)? Check for build errors.
3. Check that `ELEVENLABS_API_KEY` and `OPENAI_API_KEY` are set and non-empty.

### "Barge-in doesn't work"

Barge-in (speaking over the AI to interrupt) should work automatically. If the AI keeps talking over you:
1. This can happen if the VAD threshold is too high — lower `SILENCE_RMS_THRESHOLD`
2. Check logs for `Barge-in detected` — if it never appears, the threshold is the issue

---

## 8. How the audio pipeline works (for reference)

```
Caller speaks → Vonage → 640-byte PCM frames → echokit-server
                                                    │
                                                    ├─ RMS VAD detects speech
                                                    │
                                                    ├─ Frames streamed to ElevenLabs STT (WebSocket)
                                                    │   └─ Returns partial + final transcripts
                                                    │
                                                    ├─ On silence → commit STT → get final text
                                                    │
                                                    ├─ POST /v1/agent/turn to agent-api
                                                    │   ├─ Intent classification (GPT-4o-mini)
                                                    │   ├─ Parallel: RAG search + SQL search
                                                    │   └─ Synthesis (GPT-4o) → response text
                                                    │
                                                    ├─ Response text → OpenAI TTS (streaming)
                                                    │   └─ 24kHz PCM → downsample to 16kHz
                                                    │
                                                    └─ 640-byte PCM frames → Vonage → Caller hears AI
```

---

## How to know slice 2b is "done"

- [ ] echokit-server is deployed with all three API keys set
- [ ] Deploy logs show AI pipeline is enabled (no "disabled" warning)
- [ ] Calling your Vonage number: you hear the greeting
- [ ] You ask about vehicles and hear a relevant response mentioning cars from your inventory
- [ ] You ask a follow-up and the AI uses context from the previous turn
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
