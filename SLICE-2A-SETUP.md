# Slice 2a — AI Agent Backend (agent-api + PostgreSQL + Redis)

**Goal:** deploy the AI agent API so you can POST a text transcript and receive a voice-ready response that references real vehicle inventory and FAQ answers.

**What this proves:** the full AI pipeline works — intent classification, RAG retrieval from pgvector, Voice-to-SQL against real inventory, and GPT-4o synthesis — all without any audio involvement yet. Once this works, slice 2b just wires the audio pipe to it.

**Time estimate:** 45–60 minutes.

**What you need:**
- Your existing Railway project (from slice 1)
- An **OpenAI API key** — create one at https://platform.openai.com/api-keys. Add ~$5 in credits. The testing here will cost well under $1.
- **psql** (PostgreSQL command-line client) installed locally for running migrations. If you haven't installed it:
  - **Windows:** download "Command Line Tools" from https://www.postgresql.org/download/windows/ — during the installer, uncheck everything except "Command Line Tools"
  - **Mac:** `brew install libpq && brew link --force libpq`
  - **Linux:** `sudo apt install postgresql-client`
- **Python 3** installed locally (for the embedding seed script)
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
8. [Test with curl — vehicle search](#8-test-curl)
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

Verify on GitHub that you see `agent-api/` (including `agent-api/Dockerfile`) and `migrations/` folders.

---

## 2. Add PostgreSQL to your Railway project <a id="2-postgres"></a>

PostgreSQL is where your vehicle inventory, FAQ knowledge base, and call sessions live. Railway provisions a managed instance with one click.

1. Open your Railway project dashboard
2. Click the **+ New** button (top right of the canvas)
3. Choose **Database** → **PostgreSQL**
4. Railway instantly creates a PostgreSQL 16 instance and adds it to your project canvas
5. Click on the Postgres tile → **Variables** tab → you'll see `DATABASE_URL` and `DATABASE_PUBLIC_URL` already set

**Important distinction:**
- `DATABASE_URL` uses Railway's **internal** hostname (`postgres.railway.internal`) — only reachable from other Railway services in the same project
- `DATABASE_PUBLIC_URL` uses a **public** hostname — reachable from your local machine

You'll use `DATABASE_PUBLIC_URL` for running migrations from your computer, and `DATABASE_URL` for the agent-api service.

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

We need to create the tables, enable pgvector, add indexes, and seed test data.

### Get the public database URL

1. Click the **PostgreSQL** tile on your Railway project canvas
2. Click the **Variables** tab
3. Find `DATABASE_PUBLIC_URL` and **copy the full value**

It will look something like: `postgresql://postgres:somepassword@roundhouse.proxy.rlwy.net:12345/railway`

> ⚠️ Use `DATABASE_PUBLIC_URL` (not `DATABASE_URL`). The plain `DATABASE_URL` uses Railway's internal hostname which is not reachable from your local machine.

### Run the four migration files

Open your terminal / command prompt, navigate to your repo folder, and run these in order. Replace the URL with your actual `DATABASE_PUBLIC_URL` — keep it in quotes because it may contain special characters:

```bash
psql "YOUR_DATABASE_PUBLIC_URL" -f migrations/001_init.sql
psql "YOUR_DATABASE_PUBLIC_URL" -f migrations/002_pgvector.sql
psql "YOUR_DATABASE_PUBLIC_URL" -f migrations/003_indexes.sql
psql "YOUR_DATABASE_PUBLIC_URL" -f migrations/004_seed.sql
```

You may see a NOTICE like `trigger "vehicles_updated_at" does not exist, skipping` — this is normal. It's not an error. The migration tries to drop a trigger before creating it, and on a fresh database it doesn't exist yet.

### Verify the data is there

In the Railway SQL console (click Postgres tile → **Data** tab → **Query**):

```sql
SELECT make, model, year, price, status FROM vehicles ORDER BY price LIMIT 5;
```

Expected: 5 rows of our seed vehicles, cheapest first (Hyundai Elantra at $24,800).

---

## 5. Create the agent-api service on Railway <a id="5-create-service"></a>

The agent-api is a Python service, but our repo root has a `package.json` (for echokit-server). We use a **Dockerfile** to tell Railway exactly how to build the Python service.

1. On the project canvas, click **+ New** → **Empty Service**
2. Name it `agent-api`
3. Click on the new `agent-api` tile → **Settings** tab
4. Under **Source**, click **Connect Repo** and select your `car-dealership-voice-ai` GitHub repo
5. **Build configuration — leave these settings as follows:**
   - **Root Directory:** **leave empty** (do NOT set it to `agent-api/`)
   - **Build Command:** **leave empty**
   - **Start Command:** **leave empty** (the Dockerfile handles this)
   - **Watch Paths:** `/agent-api/**` and `/shared/python/**` (one per line)
6. Under **Networking**, click **Generate Domain** to get a public URL
7. When it asks for a port, enter **8000**

> **Why no root directory?** The Dockerfile needs access to both `agent-api/` and `shared/python/` during the build. Setting a root directory would restrict the build context to just one folder. Instead, we tell Railway where the Dockerfile is via a variable (next step).

---

## 6. Set environment variables <a id="6-env-vars"></a>

Click on the `agent-api` service → **Variables** tab → add these variables:

| Variable | Value |
|---|---|
| `RAILWAY_DOCKERFILE_PATH` | `agent-api/Dockerfile` |
| `OPENAI_API_KEY` | `sk-your-openai-api-key` |
| `DATABASE_URL` | *(see below)* |
| `REDIS_URL` | *(see below)* |
| `PORT` | `8000` |

### Getting DATABASE_URL and REDIS_URL values

Railway has a variable reference syntax (`${{ServiceName.VAR}}`) that auto-resolves, but it can be unreliable. **The safest approach is to copy the actual connection strings:**

1. Click the **PostgreSQL** tile → **Variables** tab → copy the value of `DATABASE_URL` (the one starting with `postgresql://...` that uses the **internal** hostname like `postgres.railway.internal`)
2. Paste it as the value for `DATABASE_URL` on the `agent-api` service
3. Click the **Redis** tile → **Variables** tab → copy the value of `REDIS_URL` (starting with `redis://...` using the internal hostname like `redis.railway.internal`)
4. Paste it as the value for `REDIS_URL` on the `agent-api` service

> **Why the internal URLs?** The agent-api service runs inside Railway's network, so it can reach Postgres and Redis via their internal hostnames. This is faster and doesn't count against egress limits.

Leave `INTERNAL_API_SECRET` empty for now (disables auth, which makes curl testing easy).

The `RAILWAY_DOCKERFILE_PATH` variable is the key configuration — it tells Railway: "build using the Dockerfile at `agent-api/Dockerfile`, with the repo root as build context."

Railway auto-redeploys when you change variables. Watch the **Deployments** tab — you should see Docker pulling `python:3.12-slim`, running `pip install`, and starting uvicorn.

---

## 7. Verify the deployment <a id="7-verify"></a>

Wait for the deployment to finish (watch the **Deployments** tab). Then open in a browser:

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

If both checks say `ok`, your agent-api is connected to the database and Redis.

Also try `https://<AGENT-API-URL>/` to see the plain-text endpoint list.

---

## 8. Test with curl — vehicle search <a id="8-test-curl"></a>

Vehicle search works immediately — no embeddings needed, just SQL filtering.

**Windows cmd** (use double quotes and escape inner quotes with `\"`):

```cmd
curl -s -X POST https://YOUR-AGENT-API-URL/v1/sql/search -H "Content-Type: application/json" -d "{\"entities\": {\"make\": \"Toyota\", \"price_max\": 40000}, \"limit\": 3}"
```

To pretty-print the output, pipe through Python:

```cmd
curl -s -X POST https://YOUR-AGENT-API-URL/v1/sql/search -H "Content-Type: application/json" -d "{\"entities\": {\"make\": \"Toyota\", \"price_max\": 40000}, \"limit\": 3}" | python -m json.tool
```

Expected: JSON with `vehicles` array containing the Toyota Camry and RAV4 from our seed data.

**Mac/Linux** (single quotes work):

```bash
curl -s -X POST https://YOUR-AGENT-API-URL/v1/sql/search \
  -H 'Content-Type: application/json' \
  -d '{"entities": {"make": "Toyota", "price_max": 40000}, "limit": 3}' | python3 -m json.tool
```

### Try a broader search

**Windows cmd:**

```cmd
curl -s -X POST https://YOUR-AGENT-API-URL/v1/sql/search -H "Content-Type: application/json" -d "{\"entities\": {\"body_style\": \"SUV\", \"fuel_type\": \"Hybrid\"}, \"limit\": 5}" | python -m json.tool
```

Expected: hybrid SUVs (Ford Escape, Hyundai Santa Fe, Honda CR-V).

---

## 9. Seed the embeddings <a id="9-seed-embeddings"></a>

Vehicles and knowledge chunks were inserted without embeddings (they're NULL). We need to generate embeddings so the RAG pipeline can search semantically.

### Step 1: Install httpx

```cmd
pip install httpx
```

### Step 2: Set your agent-api URL

**Windows cmd:**
```cmd
set AGENT_API_URL=https://YOUR-AGENT-API-URL.up.railway.app
```

**Mac/Linux:**
```bash
export AGENT_API_URL="https://YOUR-AGENT-API-URL.up.railway.app"
```

No trailing slash, no quotes on Windows.

### Step 3: Run the seed script

Navigate to your repo folder and run:

```cmd
python scripts/seed_embeddings_simple.py
```

This calls your agent-api to generate embeddings for all 20 vehicles and 15 knowledge chunks (takes ~10 seconds, costs about $0.01 in OpenAI credits). It produces a file called `seed_embeddings.sql` in your current folder.

### Step 4: Load embeddings into the database

Use `psql` with your `DATABASE_PUBLIC_URL` (the same one from §4):

```cmd
psql "YOUR_DATABASE_PUBLIC_URL" -f seed_embeddings.sql
```

### Step 5: Verify

In the Railway SQL console:

```sql
SELECT COUNT(*) FROM vehicles WHERE embedding IS NOT NULL;
SELECT COUNT(*) FROM knowledge_chunks WHERE embedding IS NOT NULL;
```

Should return 20 and 15 respectively.

---

## 10. Test RAG + SQL end-to-end <a id="10-test-rag-sql"></a>

This is the main event — a full conversational turn.

### Full agent turn

**Windows cmd:**

```cmd
curl -s -X POST https://YOUR-AGENT-API-URL/v1/agent/turn -H "Content-Type: application/json" -d "{\"call_uuid\": \"test-123\", \"transcript\": \"Do you have any blue Toyota SUVs under thirty-five thousand?\", \"caller_phone_hash\": \"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\", \"session_entities\": {}, \"conversation_history\": []}" | python -m json.tool
```

**Mac/Linux:**

```bash
curl -s -X POST https://YOUR-AGENT-API-URL/v1/agent/turn \
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
- `intent`: `"vehicle_search"` or `"availability_check"`
- `response_text`: a natural ~50-word voice response mentioning matching vehicles
- `results.vehicles`: matching vehicle objects
- `latency_ms`: timing breakdown for each stage

### Try a FAQ question

**Windows cmd:**

```cmd
curl -s -X POST https://YOUR-AGENT-API-URL/v1/agent/turn -H "Content-Type: application/json" -d "{\"call_uuid\": \"test-456\", \"transcript\": \"What are your hours?\", \"caller_phone_hash\": \"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"}" | python -m json.tool
```

Expected: intent is `dealership_info`, response mentions Monday–Saturday 9 AM to 8 PM (if embeddings were seeded).

### Multi-turn refinement

Run these two commands one after the other:

**Turn 1 — broad search (Windows cmd):**

```cmd
curl -s -X POST https://YOUR-AGENT-API-URL/v1/agent/turn -H "Content-Type: application/json" -d "{\"call_uuid\": \"test-789\", \"transcript\": \"I am looking for an SUV\", \"caller_phone_hash\": \"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\", \"session_entities\": {}, \"conversation_history\": []}" | python -m json.tool
```

**Turn 2 — refine with accumulated entities (Windows cmd):**

```cmd
curl -s -X POST https://YOUR-AGENT-API-URL/v1/agent/turn -H "Content-Type: application/json" -d "{\"call_uuid\": \"test-789\", \"transcript\": \"Make it a hybrid under forty thousand\", \"caller_phone_hash\": \"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\", \"session_entities\": {\"body_style\": \"SUV\"}, \"conversation_history\": [{\"role\": \"user\", \"text\": \"I am looking for an SUV\", \"ts\": \"2026-04-17T12:00:00Z\"}, {\"role\": \"assistant\", \"text\": \"We have several great SUVs\", \"ts\": \"2026-04-17T12:00:01Z\"}]}" | python -m json.tool
```

The second turn should return hybrid SUVs under $40k (Ford Escape, Hyundai Santa Fe, Honda CR-V) because the entities accumulated: `body_style=SUV` from turn 1 plus `fuel_type=Hybrid, price_max=40000` from turn 2.

---

## 11. Troubleshooting <a id="11-troubleshooting"></a>

### "Build fails with: pip: command not found"

Railway is trying to build as Node.js instead of using the Dockerfile. Fix:
- Make sure `RAILWAY_DOCKERFILE_PATH` is set to `agent-api/Dockerfile` in the **Variables** tab
- Make sure **Root Directory** is **empty** (not set to `agent-api/`)
- Make sure **Build Command** is **empty**
- Redeploy after making these changes

### "Image exceeded limit of 4.0 GB"

This happened because `sentence-transformers` (which pulls in PyTorch) was in the requirements. The updated code has it removed. Make sure your `agent-api/requirements.txt` has the `sentence-transformers` line **commented out**. The RAG pipeline automatically falls back to cosine distance ranking without it.

### "Error 111 connecting to localhost:6379 / Connection refused" (Redis)

The `REDIS_URL` variable is not set correctly — it's falling back to the default `redis://localhost:6379`. Fix:
1. Click the **Redis** tile on your Railway canvas → **Variables** tab
2. Copy the `REDIS_URL` value (the one with `redis.railway.internal` hostname)
3. Paste it as `REDIS_URL` on the `agent-api` service's Variables tab

> **Note:** The `${{Redis.REDIS_URL}}` reference syntax sometimes doesn't resolve. Pasting the actual connection string is more reliable.

### "could not translate host name postgres.railway.internal" (when running psql locally)

You're using the internal `DATABASE_URL` from your local machine. Use `DATABASE_PUBLIC_URL` instead — find it in the PostgreSQL tile's Variables tab. The public URL has an external hostname like `roundhouse.proxy.rlwy.net`.

### "psql is not recognized as a command"

You need to install the PostgreSQL command-line tools:
- **Windows:** https://www.postgresql.org/download/windows/ — install only "Command Line Tools"
- **Mac:** `brew install libpq && brew link --force libpq`
- **Linux:** `sudo apt install postgresql-client`

### "Railway SQL console runs query successfully but no tables created"

The Railway SQL console sometimes only executes the first statement in a multi-statement paste. Use `psql` from your terminal instead (see §4). This is more reliable for running migration files that contain multiple statements.

### "/healthz shows postgres: error"

- Verify the `DATABASE_URL` value on agent-api is the **internal** URL (containing `postgres.railway.internal`), NOT the public URL
- Run `SELECT 1;` in the Railway SQL console to make sure Postgres itself is running

### "/healthz shows redis: error"

- Verify the `REDIS_URL` value contains `redis.railway.internal` (internal hostname)
- Click the Redis tile and make sure it shows status "Active"

### "SQL search returns empty vehicles"

Run `SELECT COUNT(*) FROM vehicles WHERE status = 'available';` in the Railway SQL console. Should be 20. If 0, the seed migration (`004_seed.sql`) wasn't run.

### "Agent turn returns 500"

Check Railway deploy logs for the stack trace. Most common cause: `OPENAI_API_KEY` not set or invalid.

### "RAG query returns no chunks / grounded: false"

Embeddings haven't been generated yet. Run the seed script (§9). SQL search works without embeddings, but RAG needs them.

### "seed_embeddings.py fails with: No module named 'asyncpg'"

You're running the wrong script. Use `seed_embeddings_simple.py` (note the `_simple`). It only needs `httpx`, no database drivers.

---

## 12. Concepts introduced in this slice <a id="12-concepts"></a>

### asyncpg
A fast async PostgreSQL driver for Python. Unlike psycopg2 (the traditional driver), asyncpg doesn't block the event loop — critical for a service handling many concurrent requests. Connection pooling (min=2, max=10) reuses connections instead of opening new ones per request.

### pgvector HNSW index
HNSW (Hierarchical Navigable Small World) is an algorithm for approximate nearest-neighbor search. It builds a graph structure over your vectors so finding the closest match takes ~10ms instead of scanning every row. Parameters: `m=16` (graph connectivity), `ef_construction=64` (build-time search width). Higher = better recall but slower builds and more memory.

### Cross-encoder reranker (disabled for now)
After pgvector returns the top-5 approximate matches, a cross-encoder model can re-score them more accurately. We disabled this for slice 2a because it pulls in PyTorch (~4GB), which exceeds Railway's free-tier image size limit. The RAG pipeline falls back to cosine distance ranking instead — slightly less accurate but still functional. We'll re-enable it in slice 6 (hardening) on a larger plan.

### Voice-to-SQL safety validator
The LLM generates SQL from natural language, but we can't trust it blindly. The validator (`sql_agent.py`) rejects any query containing `INSERT/UPDATE/DELETE/DROP/ALTER`, requires `WHERE status = 'available'`, and ensures parameterized placeholders. If the LLM produces unsafe SQL, we fall back to hand-written template queries for the most common search patterns.

### asyncio.gather (parallel execution)
Python's way to run multiple async operations concurrently. In `agent.py`, RAG and SQL run in parallel — neither waits for the other. This saves ~200ms because the two tracks are independent until synthesis.

### Dockerfile vs Nixpacks
Railway normally auto-detects your language and builds with Nixpacks. But our monorepo has Node.js at the root and Python in a subdirectory, which confuses auto-detection. The Dockerfile gives us explicit control: we specify `python:3.12-slim` as the base image, copy in the files we need, and install dependencies exactly how we want. The `RAILWAY_DOCKERFILE_PATH` variable tells Railway where to find it.

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
- [ ] Embeddings are seeded (20 vehicles + 15 knowledge chunks)
- [ ] `echokit-server` is still running (slice 1 unchanged)

Reply **"slice 2b"** when you're ready to wire the audio pipeline.
