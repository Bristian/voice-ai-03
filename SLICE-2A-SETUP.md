# Slice 2a — AI Agent Backend (agent-api + PostgreSQL + Redis)

**Goal:** deploy the AI agent API so you can POST a text transcript and receive a voice-ready response that references real vehicle inventory and FAQ answers.

**What this proves:** the full AI pipeline works — intent classification, RAG retrieval from pgvector, Voice-to-SQL against real inventory, and GPT-4o synthesis — all without any audio involvement yet. Once this works, slice 2b just wires the audio pipe to it.

**Time estimate:** 30–45 minutes.

**What you need:**
- Your existing Railway project (from slice 1)
- An **OpenAI API key** — create one at https://platform.openai.com/api-keys. Add ~$5 in credits. The testing here will cost well under $1.
- Your slice 1 echokit-server should still be running (we won't touch it)

---

## Table of contents

1. [Upload the slice 2a code to GitHub](#1-upload)
2. [Add PostgreSQL to your Railway project](#2-postgres)
3. [Add Redis to your Railway project](#3-redis)
4. [Run database migrations](#4-migrations)
5. [Create the agent-api service on Railway](#5-create-service)
6. [Set environment variables](#6-env-vars)
7. [Verify the deployment](#7-verify)
8. [Test with curl — the fun part](#8-test-curl)
9. [Seed the embeddings](#9-seed-embeddings)
10. [Test RAG + SQL end-to-end](#10-test-rag-sql)
11. [Troubleshooting](#11-troubleshooting)
12. [Concepts introduced in this slice](#12-concepts)
13. [What slice 2b will add](#13-next)

---

## 1. Upload the slice 2a code to GitHub <a id="1-upload"></a>

Same as before — the zip contains the complete repo (slices 0 + 1 + 2a).

```bash
cd your-local-repo
# Replace all contents with the new zip
git add -A
git commit -m "slice 2a: agent-api + PostgreSQL + Redis + migrations"
git push
```

Verify on GitHub that you see `agent-api/` and `migrations/` folders.

---

## 2. Add PostgreSQL to your Railway project <a id="2-postgres"></a>

PostgreSQL is where your vehicle inventory, FAQ knowledge base, and call sessions live. Railway provisions a managed instance with one click.

1. Open your Railway project dashboard
2. Click the **+ New** button (top right of the canvas)
3. Choose **Database** → **PostgreSQL**
4. Railway instantly creates a PostgreSQL 16 instance and adds it to your project canvas
5. Click on the Postgres tile → **Variables** tab → you'll see `DATABASE_URL` already set

**What just happened:** Railway provisioned a dedicated PostgreSQL server, assigned it connection credentials, and made `DATABASE_URL` available as a shared variable to any service in the same project. The `pgvector` extension is pre-installed on Railway's managed Postgres — no extra setup needed.

### What is PostgreSQL?

PostgreSQL (often just "Postgres") is a relational database — it stores data in tables with rows and columns, and you query it with SQL. It's the industry standard for applications that need structured data. Railway runs it as a managed service so you don't configure servers, backups, or security yourself.

### What is pgvector?

An extension (plugin) for PostgreSQL that adds a new column type called `vector`. This lets you store and search embeddings — lists of numbers that represent the "meaning" of text. When a caller asks "do you have something sporty?", we convert that question into a vector and find the most similar vehicle descriptions using pgvector's HNSW index, which does approximate nearest-neighbor search in milliseconds.

---

## 3. Add Redis to your Railway project <a id="3-redis"></a>

Redis is our in-memory cache — sessions, TTS audio blobs, query result caches, and rate limiting.

1. Click **+ New** on the project canvas again
2. Choose **Database** → **Redis**
3. Railway instantly provisions Redis and adds `REDIS_URL` to the shared variables

**What is Redis?** An extremely fast key-value store that keeps data in RAM. Reading a value takes under 1 millisecond. We use it to avoid re-calling OpenAI for embeddings we've already computed, and to cache vehicle query results so repeated similar questions don't hit the database.

---

## 4. Run database migrations <a id="4-migrations"></a>

We need to create the tables, enable pgvector, add indexes, and seed test data. Railway provides a way to run one-off commands against your database.

### Option A: Railway CLI (recommended)

If you have the Railway CLI installed (`npm install -g @railway/cli`):

```bash
# Authenticate
railway login

# Link to your project
railway link

# Run migrations in order
railway run psql $DATABASE_URL -f migrations/001_init.sql
railway run psql $DATABASE_URL -f migrations/002_pgvector.sql
railway run psql $DATABASE_URL -f migrations/003_indexes.sql
railway run psql $DATABASE_URL -f migrations/004_seed.sql
```

### Option B: Railway database console (no CLI needed)

1. Click the **PostgreSQL** tile on your project canvas
2. Click the **Data** tab
3. Click **Query** (or the SQL editor button)
4. Copy-paste the contents of each migration file, one at a time, in order:
   - `migrations/001_init.sql`
   - `migrations/002_pgvector.sql`
   - `migrations/003_indexes.sql`
   - `migrations/004_seed.sql`
5. Click **Run** after each one

### Verify the data is there

Run this query in the Railway SQL console:

```sql
SELECT make, model, year, price, status FROM vehicles ORDER BY price LIMIT 5;
```

Expected: 5 rows of our seed vehicles, cheapest first (Hyundai Elantra at $24,800).

```sql
SELECT source, LEFT(content, 60) AS preview FROM knowledge_chunks LIMIT 5;
```

Expected: FAQ/policy/financing chunks.

---

## 5. Create the agent-api service on Railway <a id="5-create-service"></a>

1. On the project canvas, click **+ New** → **Empty Service**
2. Name it `agent-api`
3. Click on the new `agent-api` tile → **Settings** tab
4. Under **Source**, click **Connect Repo** and select your `car-dealership-voice-ai` GitHub repo
5. **Important — Build configuration:**
   - **Install Command:** `pip install --no-cache-dir -r agent-api/requirements.txt && pip install --no-cache-dir -e shared/python`
   - **Build Command:** (leave empty)
   - **Start Command:** `cd agent-api && uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000}`
   - **Watch Paths:** `/agent-api/**` and `/shared/python/**` (one per line)
6. Under **Networking**, click **Generate Domain** to get a public URL
7. When it asks for a port, enter **8000**

> **Why these custom commands?** Railway sees a Node.js monorepo at the root (because of `package.json`). We override the build to tell it "this service is Python, install these specific packages."

Click **Deploy** (or it may auto-deploy when you save settings and the repo is connected).

---

## 6. Set environment variables <a id="6-env-vars"></a>

Click on the `agent-api` service → **Variables** tab → add:

| Variable | Value |
|---|---|
| `OPENAI_API_KEY` | `sk-your-openai-api-key` |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `REDIS_URL` | `${{Redis.REDIS_URL}}` |
| `PORT` | `8000` |

> **The `${{...}}` syntax** is Railway's variable reference — it automatically resolves to the Postgres/Redis connection string. Type it exactly as shown; Railway will expand it.

Leave `INTERNAL_API_SECRET` empty for now (disables auth, which makes curl testing easy).

Railway auto-redeploys when you change variables.

---

## 7. Verify the deployment <a id="7-verify"></a>

Wait for the deployment to finish (watch the **Deployments** tab). Then open:

```
https://<AGENT-API-URL>/healthz
```

Expected:

```json
{
  "status": "ok",
  "service": "agent-api",
  "checks": {
    "postgres": "ok",
    "redis": "ok"
  }
}
```

If both checks say `ok`, your agent-api is connected to the database and Redis. If either says `error`, jump to [Troubleshooting](#11-troubleshooting).

Also try `https://<AGENT-API-URL>/` to see the plain-text endpoint list.

---

## 8. Test with curl — the fun part <a id="8-test-curl"></a>

### 8a. Vehicle search (SQL track)

```bash
curl -s -X POST https://<AGENT-API-URL>/v1/sql/search \
  -H 'Content-Type: application/json' \
  -d '{
    "entities": {"make": "Toyota", "price_max": 40000},
    "limit": 3
  }' | python3 -m json.tool
```

Expected: JSON with `vehicles` array containing the Toyota Camry and RAV4 from our seed data.

### 8b. Try a broader search

```bash
curl -s -X POST https://<AGENT-API-URL>/v1/sql/search \
  -H 'Content-Type: application/json' \
  -d '{
    "entities": {"body_style": "SUV", "fuel_type": "Hybrid"},
    "limit": 5
  }' | python3 -m json.tool
```

Expected: hybrid SUVs (Ford Escape, Hyundai Santa Fe, Honda CR-V, Toyota Prius).

> **Note:** SQL search works without embeddings. The RAG pipeline (next section) needs embeddings to be populated first.

---

## 9. Seed the embeddings <a id="9-seed-embeddings"></a>

The vehicles and knowledge chunks were inserted without embeddings (they're NULL). We need to generate embeddings so the RAG pipeline can search semantically.

Run this command — it calls the agent-api's `/v1/embeddings` endpoint to generate embeddings, then updates the database:

### Quick seed script

From your Railway Postgres SQL console (or via `railway run psql`), first check what needs embeddings:

```sql
SELECT COUNT(*) AS need_embedding FROM vehicles WHERE embedding IS NULL;
SELECT COUNT(*) AS need_embedding FROM knowledge_chunks WHERE embedding IS NULL;
```

Now use this curl-based approach to embed the knowledge base (run from your terminal):

```bash
# Embed knowledge chunks - extract content, embed, update
# This is a simplified approach. The ingestion-worker (slice 6) automates this.

AGENT_URL="https://<AGENT-API-URL>"

# Test that embeddings endpoint works
curl -s -X POST "$AGENT_URL/v1/embeddings" \
  -H 'Content-Type: application/json' \
  -d '{"texts": ["test embedding"], "cache": false}' | python3 -c "
import json, sys
d = json.load(sys.stdin)
print(f'Embedding dims: {len(d[\"embeddings\"][0])}')
"
```

Expected output: `Embedding dims: 1536`

For the actual seeding, we'll use the RAG query endpoint — the first time you query, it will embed your query on the fly. But vehicles and knowledge chunks in the database need their embeddings populated for pgvector search to work.

**The simplest approach for testing:** run a small Python script locally that pulls content from the DB, embeds it via the API, and updates the rows. I'll include this as `scripts/seed_embeddings.py` in the repo:

```bash
# If you have Python locally:
cd your-repo
pip install httpx asyncpg python-dotenv

# Set your DATABASE_URL and agent-api URL:
export DATABASE_URL="postgresql://..."  # from Railway Postgres Variables tab
export AGENT_API_URL="https://<AGENT-API-URL>"

python3 scripts/seed_embeddings.py
```

If you don't have Python locally, you can skip embedding seeding for now — the SQL search (`/v1/sql/search`) works without embeddings, and the full `/v1/agent/turn` endpoint will work for vehicle searches. RAG queries for FAQ/policy content will just return no chunks until embeddings are populated.

---

## 10. Test RAG + SQL end-to-end <a id="10-test-rag-sql"></a>

This is the main event — a full conversational turn:

```bash
curl -s -X POST https://<AGENT-API-URL>/v1/agent/turn \
  -H 'Content-Type: application/json' \
  -d '{
    "call_uuid": "test-123",
    "transcript": "Do you have any blue Toyota SUVs under thirty-five thousand?",
    "caller_phone_hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "session_entities": {},
    "conversation_history": []
  }' | python3 -m json.tool
```

Expected response includes:
- `intent`: `"vehicle_search"` (or `"availability_check"`)
- `response_text`: a natural ~50-word voice response mentioning matching Toyotas
- `results.vehicles`: matching vehicle objects
- `latency_ms`: timing breakdown for each stage

### Try a FAQ question

```bash
curl -s -X POST https://<AGENT-API-URL>/v1/agent/turn \
  -H 'Content-Type: application/json' \
  -d '{
    "call_uuid": "test-456",
    "transcript": "What are your hours?",
    "caller_phone_hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }' | python3 -m json.tool
```

Expected: intent is `dealership_info`, response mentions hours (if embeddings are seeded).

### Multi-turn refinement

```bash
# Turn 1: broad search
curl -s -X POST https://<AGENT-API-URL>/v1/agent/turn \
  -H 'Content-Type: application/json' \
  -d '{
    "call_uuid": "test-789",
    "transcript": "I am looking for an SUV",
    "caller_phone_hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "session_entities": {},
    "conversation_history": []
  }' | python3 -m json.tool

# Turn 2: refine with accumulated entities
curl -s -X POST https://<AGENT-API-URL>/v1/agent/turn \
  -H 'Content-Type: application/json' \
  -d '{
    "call_uuid": "test-789",
    "transcript": "Make it a hybrid under forty thousand",
    "caller_phone_hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "session_entities": {"body_style": "SUV"},
    "conversation_history": [
      {"role": "user", "text": "I am looking for an SUV", "ts": "2026-04-17T12:00:00Z"},
      {"role": "assistant", "text": "We have several great SUVs...", "ts": "2026-04-17T12:00:01Z"}
    ]
  }' | python3 -m json.tool
```

The second turn should return hybrid SUVs under $40k because the entities accumulated: `body_style=SUV` (from turn 1) + `fuel_type=Hybrid, price_max=40000` (from turn 2).

---

## 11. Troubleshooting <a id="11-troubleshooting"></a>

### "Build fails with pip errors"

Check the deploy logs. Common causes:
- **`ModuleNotFoundError: No module named 'voiceai_contracts'`** — the install command didn't include `pip install -e shared/python`. Verify the Install Command in Settings matches exactly what's in §5.
- **`invalid requirement`** — Railway may be trying to use npm instead of pip. Make sure the Install Command starts with `pip install`.

### "/healthz shows postgres: error"

- Check that `DATABASE_URL` variable on agent-api uses the Railway reference syntax: `${{Postgres.DATABASE_URL}}`
- Check that you ran the migrations. If the tables don't exist, some health checks might still pass but queries will fail.

### "/healthz shows redis: error"

- Check that `REDIS_URL` uses `${{Redis.REDIS_URL}}`
- The Redis plugin must be in the same Railway project as agent-api

### "SQL search returns empty vehicles"

- Run `SELECT COUNT(*) FROM vehicles WHERE status = 'available';` in the Railway SQL console. Should be 20.
- If 0, the seed migration (`004_seed.sql`) wasn't run. Run it.

### "Agent turn returns 500"

- Check Railway deploy logs for the stack trace
- Most common: `OPENAI_API_KEY` not set or invalid. Verify it in the Variables tab.

### "RAG query returns no chunks / grounded: false"

- Embeddings haven't been generated yet. Either run the seed script (§9) or accept that RAG won't work until embeddings are populated. SQL search works without embeddings.

---

## 12. Concepts introduced in this slice <a id="12-concepts"></a>

### asyncpg
A fast async PostgreSQL driver for Python. Unlike psycopg2 (the traditional driver), asyncpg doesn't block the event loop — critical for a service handling many concurrent requests. Connection pooling (min=2, max=10) reuses connections instead of opening new ones per request.

### pgvector HNSW index
HNSW (Hierarchical Navigable Small World) is an algorithm for approximate nearest-neighbor search. It builds a graph structure over your vectors so finding the closest match takes ~10ms instead of scanning every row. Parameters: `m=16` (graph connectivity), `ef_construction=64` (build-time search width). Higher = better recall but slower builds and more memory.

### Cross-encoder reranker
After pgvector returns the top-5 approximate matches, we re-score them with a more accurate (but slower) model: `cross-encoder/ms-marco-MiniLM-L-6-v2`. This catches cases where the embedding similarity is misleading. The cross-encoder reads both the query AND the chunk together and scores relevance, producing better rankings than pure vector distance.

### Voice-to-SQL safety validator
The LLM generates SQL from natural language, but we can't trust it blindly. The validator (`sql_agent.py`) rejects any query containing `INSERT/UPDATE/DELETE/DROP/ALTER`, requires `WHERE status = 'available'`, and ensures parameterized placeholders. If the LLM produces unsafe SQL, we fall back to hand-written template queries for the 10 most common search patterns.

### asyncio.gather (parallel execution)
Python's way to run multiple async operations concurrently. In `agent.py`, RAG and SQL run in parallel — neither waits for the other. This saves ~200ms because the two tracks are independent until synthesis.

---

## 13. What slice 2b will add <a id="13-next"></a>

Slice 2b connects the audio pipeline to this agent:

- **echokit-server changes:** instead of echoing, it streams audio to ElevenLabs STT, posts the transcript to agent-api's `/v1/agent/turn`, sends the response text to OpenAI TTS, and streams the PCM back to Vonage
- **Silero VAD** replaces the RMS-based voice detection
- **Redis session state** — echokit-server stores/loads session across turns
- **TTS caching** — repeated phrases (greetings, disclaimers) are cached in Redis

After slice 2b, you'll call your Vonage number and have a real conversation about cars.

---

## How to know slice 2a is "done"

- [ ] `agent-api` is deployed and active on Railway
- [ ] `/healthz` shows postgres: ok, redis: ok
- [ ] `/v1/sql/search` returns matching vehicles from seed data
- [ ] `/v1/agent/turn` returns a synthesized voice response with correct intent
- [ ] Multi-turn entity accumulation works (pass entities from turn 1 to turn 2)
- [ ] `echokit-server` is still running (slice 1 unchanged)

Reply **"slice 2b"** when you're ready to wire the audio pipeline.
