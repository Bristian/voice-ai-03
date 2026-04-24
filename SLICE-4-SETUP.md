# Slice 4 — Parallel Processing + TTS Caching

**Goal:** reduce perceived latency by ~500ms on knowledge questions and eliminate TTS API calls for repeated responses.

**What this improves:**
- Knowledge questions (hours, financing, etc.) are ~500ms faster because embedding starts before intent classification finishes
- Repeated identical responses (greetings, transfer messages, common FAQ answers) play from cache — 0ms TTS instead of ~2000ms
- No new env vars, no new infrastructure, no migrations

**Time estimate:** 5 minutes — push and redeploy.

---

## What changed

### agent-api: Parallel intent + embedding

Previously, the pipeline was strictly serial:
```
intent classification (1000ms) → embedding (500ms) → pgvector search (10ms) → synthesis (1000ms)
                                                                               Total: ~2500ms
```

Now, embedding starts at the same time as intent classification:
```
intent classification (1000ms) ─────────────────────┐
embedding (500ms) ──────────┐                       │
                            ├─ pgvector search (10ms) → synthesis (1000ms)
                                                                Total: ~2010ms
```

For knowledge questions (hours, financing, policies), this saves the full embedding time (~500ms) because the embedding is already done by the time intent classification finishes. For vehicle questions, the embedding is discarded (no wasted cost since it's cached in Redis anyway).

### echokit-server: TTS audio cache

An in-memory LRU cache stores the PCM audio frames for each unique response text. When the AI generates the exact same response text:
- **Cache MISS** (first time): calls OpenAI TTS, streams audio, stores frames in cache → ~2000ms
- **Cache HIT** (same text again): plays frames directly from memory → ~0ms

The cache holds up to 50 entries (~8MB of audio). It helps most with:
- Static greeting messages
- Transfer messages ("Let me connect you with a sales team member")
- Error fallbacks
- FAQ answers that happen to be worded identically (rare since GPT generates slight variations)

Look for these log lines to see it working:
```
TTS cache MISS — calling OpenAI     ← first time
TTS cache HIT                        ← subsequent identical text
```

---

## 1. Upload and deploy

```bash
cd your-local-repo
git add -A
git commit -m "slice 4: parallel intent+embedding, TTS audio cache"
git push
```

Wait for both services to redeploy.

---

## 2. Test the improvements

### Verify parallel embedding

Call your Vonage number and ask "What are your hours?" Check the agent-api logs. You should see:

```
RAG track: 3 chunks, top_score=0.438 in XXXms (embedding was pre-started)
```

The `(embedding was pre-started)` message confirms the parallel path is working. Compare the `rag` time with your previous logs — it should be lower because the embedding was already computed while intent classification was running.

### Verify TTS cache

In the same call:
1. Ask a question → AI responds (log shows `TTS cache MISS`)
2. Hang up
3. Call again immediately and ask the exact same question
4. If the AI generates the exact same response text, the log shows `TTS cache HIT` and the response plays instantly

Note: the TTS cache is in-memory, so it resets on redeploy. And since GPT varies its wording slightly, cache hits mainly occur for static messages (greeting, transfer, error fallback).

---

## 3. Expected latency improvements

Based on your previous logs:

| Turn type | Before | After | Improvement |
|---|---|---|---|
| Vehicle search | ~2800ms | ~2800ms | (no change — no RAG) |
| FAQ (first ask) | ~3900ms | ~3400ms | ~500ms (parallel embedding) |
| FAQ (cached embed) | ~2400ms | ~2400ms | (embed was already cached) |
| Repeat exact text | ~2400ms | ~1000ms | ~1400ms (TTS cache hit) |

The biggest win is the parallel embedding on first-time knowledge questions. TTS caching is a bonus for repeat interactions.

---

## 4. Troubleshooting

### "I don't see 'embedding was pre-started' in logs"

The message only appears for knowledge intents (dealership_info, financing_inquiry, appointment_request). Vehicle search intents cancel the embedding task.

### "TTS cache never hits"

Expected — GPT generates slightly different wording each time. The cache mainly catches static messages. You can verify it works by looking for cache hits on the transfer message or error fallback.

### "Agent-api crashes with asyncio.CancelledError"

This shouldn't happen — `_safe_embed` catches `CancelledError` and returns `None`. If you see it, the error is elsewhere. Check the full stack trace in the logs.

---

## How to know slice 4 is "done"

- [ ] Agent-api logs show `(embedding was pre-started)` for knowledge questions
- [ ] Echokit-server logs show `TTS cache MISS` on first responses
- [ ] FAQ questions feel slightly faster than before
- [ ] Everything that worked in slice 3 still works

---

## What's next

| Slice | Goal |
|---|---|
| 5 | Supervisor dashboard + WebRTC listen-in |
| 6 | Hardening — call recording, rate limiting, observability, cross-encoder reranker |

Reply **"slice 5"** when you're ready to continue.
