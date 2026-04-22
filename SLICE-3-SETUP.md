# Slice 3 — Search Reliability + Latency + Voice Quality

**Goal:** make the AI agent reliably find vehicles, respond faster, and speak more concisely.

**What this fixes:**
- Vehicle searches that returned 0 results even when matching vehicles exist
- 9+ second response latency on the first turn
- AI responses that are too long for natural phone conversation

**Time estimate:** 5 minutes — just push code and redeploy. No new env vars or infrastructure.

---

## What changed

All changes are in `agent-api/` — the echokit-server is untouched.

### 1. Template-first SQL (biggest latency win)

Previously, every vehicle search went through the LLM (GPT-4o-mini) to generate SQL, then validated and executed it. This added ~200-400ms per turn.

Now: `template_search()` builds parameterized SQL directly from the extracted entities — no LLM call needed. The LLM SQL generator only fires as a fallback if the template returns 0 results. For simple queries like "Toyota SUVs under $35k," the template path takes ~10-50ms instead of ~300ms.

### 2. Fixed SQL validator

The validator was rejecting valid LLM-generated queries because:
- It counted trailing semicolons (which GPT-4o-mini always adds) as "multiple statements"
- The check logic had edge cases

Now: the validator strips trailing semicolons before checking, and the forbidden-keyword detection is cleaner.

### 3. Fixed intent routing

Previously, `BOTH_INTENTS = SQL_INTENTS | RAG_INTENTS` meant every intent ran both tracks every time — doubling the work unnecessarily. Now:
- Vehicle intents → SQL track only (fast)
- Knowledge intents → RAG track only
- Unknown/ambiguous → both in parallel

### 4. Shorter voice responses

The synthesis prompt now enforces:
- 1-2 sentences maximum, under 40 words
- At most 2 vehicles per response (was 3)
- No preambles ("Great question!", "Here's what I found")
- `max_tokens` reduced from 150 to 100

### 5. Better constraint widening

When a search returns 0 results, the system now drops constraints in a smarter order and tries harder (including a 30% price increase instead of 20%, and dropping body_style as a last resort).

---

## 1. Upload and deploy

```bash
cd your-local-repo
git add -A
git commit -m "slice 3: search reliability + latency + voice quality"
git push
```

Railway auto-redeploys both services (echokit-server picks up the new code from the repo, agent-api rebuilds its Docker image).

Wait for both deployments to finish.

---

## 2. Test the improvements

### Vehicle search reliability

**Windows cmd:**
```cmd
curl -s -X POST https://YOUR-AGENT-API-URL/v1/sql/search -H "Content-Type: application/json" -d "{\"entities\": {\"make\": \"Toyota\", \"body_style\": \"SUV\"}, \"limit\": 3}" | python -m json.tool
```

Should return the Toyota RAV4 (the only Toyota SUV in the seed data). Previously this might have returned 0 results.

### Latency improvement

```cmd
curl -s -X POST https://YOUR-AGENT-API-URL/v1/agent/turn -H "Content-Type: application/json" -d "{\"call_uuid\": \"test-s3\", \"transcript\": \"Do you have any SUVs?\", \"caller_phone_hash\": \"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}" | python -m json.tool
```

Check the `latency_ms` object in the response. The `sql_ms` should be much lower than before (under 100ms for template hits, vs 200-400ms for LLM-generated SQL). The `total_ms` should be noticeably lower on the second call.

### Shorter responses

The `response_text` should be 1-2 sentences, under 40 words. Compare with the 193-character responses from slice 2b.

### Phone test

Call your Vonage number and try:
- *"Do you have any SUVs?"* — should respond with SUVs and their prices
- *"Something under thirty thousand?"* — should narrow results
- *"What are your hours?"* — should get a concise FAQ answer
- *"Do you offer financing?"* — should get a short financing overview

The response should feel faster and more natural than before.

---

## 3. Troubleshooting

### "Still getting vehicleCount: 0"

Check the agent-api deploy logs during your curl test. You should see:
```
Template SQL: SELECT * FROM vehicles WHERE status = 'available' AND body_style ILIKE $1 ... | params: ['%SUV%']
Template search: 7 vehicles in 15ms
```

If you see `Template returned 0 results — trying LLM SQL generation`, the template ran but found nothing. Run this in the Railway SQL console to check the raw data:
```sql
SELECT make, model, body_style FROM vehicles WHERE status = 'available' AND body_style ILIKE '%SUV%';
```

### "Agent-api didn't redeploy"

If agent-api's Dockerfile didn't trigger a rebuild, force it:
- Railway → agent-api tile → three-dot menu → **Redeploy**

### "Latency is still high"

The first call after redeploy is always slow (cold start). Test the second call for a fair comparison. If still slow, check which stage is the bottleneck in `latency_ms`:
- `intent_ms > 500` → OpenAI API latency. Not much you can do except use GPT-4o-mini (which we already do).
- `sql_ms > 200` → template should be fast; check if it's falling back to LLM SQL.
- `synthesis_ms > 1000` → GPT-4o synthesis. Consider changing `synthesis_model` to `gpt-4o-mini` in agent-api env vars.

---

## How to know slice 3 is "done"

- [ ] `/v1/sql/search` with `{"make": "Toyota", "body_style": "SUV"}` returns 1+ vehicles
- [ ] `/v1/agent/turn` response is under 40 words
- [ ] `latency_ms.sql_ms` is under 100ms for template-matchable queries
- [ ] Phone call: you hear a concise response mentioning actual vehicles
- [ ] Follow-up questions work and narrow results correctly

---

## What's next

| Slice | Goal |
|---|---|
| 4 | Silero VAD (neural, replaces RMS) + fine-tuning |
| 5 | Supervisor dashboard + WebRTC listen-in |
| 6 | Hardening — call recording, rate limiting, observability, cross-encoder reranker |

Reply **"slice 4"** when you're ready to continue.
