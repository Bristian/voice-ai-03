# Slice 4 — Single-Call Knowledge Responses + TTS Caching

**Goal:** cut ~1000ms off knowledge question latency by merging intent classification and response generation into a single LLM call. Plus TTS audio caching for repeated responses.

**What this improves:**
- Knowledge questions (hours, financing, policies) answered in ONE LLM call instead of two — saves ~1000ms
- Vehicle questions still use two calls (intent → SQL → synthesis) because the response depends on DB results
- TTS audio cache eliminates OpenAI TTS calls for repeated identical response text
- No new env vars, no new infrastructure, no migrations

**Time estimate:** 5 minutes — push and redeploy.

---

## What changed

### agent-api: Unified single-call for knowledge intents (biggest win)

Previously, every turn required TWO sequential LLM calls:
```
Call 1: Intent classification (GPT-4o-mini, ~1000ms)
Call 2: Response synthesis  (GPT-4o-mini, ~1200ms)
                                          Total: ~2200ms of LLM time
```

Now, for knowledge questions (hours, financing, policies, appointments):
```
Call 1: Unified intent + response (GPT-4o-mini, ~1500ms)
                                          Total: ~1500ms of LLM time
```

The knowledge base FAQ content is embedded directly in the system prompt at startup, so the LLM has everything it needs to classify intent AND generate the response in one shot. No RAG search, no embedding, no second LLM call.

For vehicle questions, the unified call still returns the intent and entities, but `response=null` — the system then does SQL lookup and a short synthesis call as before. So vehicle queries are unchanged in latency.

**New file:** `agent-api/app/unified_turn.py` — the single-call module.

**How the knowledge base is loaded:** at startup, `main.py` fetches all `knowledge_chunks` from PostgreSQL and injects them into the unified turn's system prompt. The FAQ corpus is small (~3KB) and fits comfortably in GPT-4o-mini's context window.

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

### Verify unified single-call for knowledge questions

Call your Vonage number and ask "What are your hours?" Check the agent-api logs. You should see:

```
Unified call in 1400ms: {"intent":"dealership_info","confidence":1.0,"entities":{},"response":"We're open Monday to Saturday..."}
Turn complete (unified): 1420ms total (single LLM call) → 130 chars
```

The key line is `Turn complete (unified)` — this means the entire turn was handled in one LLM call. Compare with your previous logs where it was `Turn complete: 3127ms total`.

### Verify vehicle queries still work

Ask "Do you have any SUVs?" — the logs should show:

```
Turn: intent=availability_check, unified_response=no (needs vehicle lookup)
SQL track: 5 vehicles in 6ms
Turn complete (vehicle): 2800ms total (unified=1200, sql=6, synth=900)
```

Vehicle queries still take ~2800ms because they need the SQL lookup + synthesis call. But knowledge queries are now ~1500ms instead of ~3000ms.

---

## 3. Expected latency improvements

Based on your previous logs:

| Turn type | Before (slice 3) | After (slice 4) | Improvement |
|---|---|---|---|
| FAQ (hours, financing) | ~2400-3100ms | ~1400-1600ms | **~1000ms faster** |
| Vehicle search | ~2800ms | ~2800ms | (unchanged) |
| Human transfer | ~1000ms | ~1000ms | (unchanged) |
| Repeat exact response | ~2400ms | ~0ms TTS + 1500ms LLM | TTS cache hit |

---

## 4. Troubleshooting

### "I don't see 'Turn complete (unified)' in logs"

The unified path only runs for non-vehicle intents (dealership_info, financing_inquiry, appointment_request, human_transfer). Vehicle intents still show `Turn complete (vehicle)`.

### "Knowledge answers seem less accurate than before"

The unified call uses the FAQ content embedded in the system prompt instead of pgvector RAG search. If a question isn't covered by the seeded knowledge base, the LLM may give a generic answer. The seeded data covers: hours, location, contact info, test drives, trade-ins, returns, warranty, financing rates, payment methods, leasing, service department, promotions, military discount, and referral program.

### "TTS cache never hits"

Expected for most responses — GPT generates slightly different wording each time. The cache mainly catches static messages (transfer, error fallback). Verify it works by looking for `TTS cache HIT` in echokit-server logs.

### "Unified turn loaded 0 knowledge chunks"

The knowledge base wasn't loaded at startup. Check:
1. Did you run the seed migration (`004_seed.sql`)?
2. Is the `knowledge_chunks` table populated? Run `SELECT COUNT(*) FROM knowledge_chunks;` in Railway SQL console — should be 15.

---

## How to know slice 4 is "done"

- [ ] Agent-api logs show `Turn complete (unified)` for knowledge questions (hours, financing)
- [ ] Agent-api logs show `Turn complete (vehicle)` for vehicle questions (SUVs, pricing)
- [ ] Knowledge question total latency is ~1400-1600ms (down from ~2400-3100ms)
- [ ] Echokit-server logs show `TTS cache MISS` on first responses
- [ ] FAQ questions still return correct answers
- [ ] Vehicle searches still return correct results

---

## What's next

| Slice | Goal |
|---|---|
| 5 | Supervisor dashboard + WebRTC listen-in |
| 6 | Hardening — call recording, rate limiting, observability, cross-encoder reranker |

Reply **"slice 5"** when you're ready to continue.
