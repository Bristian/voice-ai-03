# agent-api

Stateless HTTP API — all LLM orchestration, RAG retrieval, and Voice-to-SQL.

**Slice 2a scope:** full agent pipeline, verified with curl. No audio pipeline yet.

## What it does

1. **Intent classification** — GPT-4o-mini classifies caller utterances into 7 intent types
2. **Entity extraction** — makes/models/years/prices pulled from natural language, merged across turns
3. **RAG pipeline** — embed query → pgvector HNSW search → cross-encoder rerank → grounded answer
4. **Voice-to-SQL** — LLM-generated parameterized SQL with safety validator + fallback templates
5. **Response synthesis** — GPT-4o merges everything into a ~50-word voice-natural reply

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/agent/turn` | Full turn: intent → parallel RAG + SQL → synthesis |
| POST | `/v1/rag/query` | RAG-only retrieval |
| POST | `/v1/sql/search` | Voice-to-SQL vehicle search |
| POST | `/v1/embeddings` | Batch embedding (for ingestion-worker) |
| GET | `/healthz` | Liveness probe (checks PG + Redis) |

## File layout

```
app/
├── main.py           # FastAPI app + routes
├── config.py         # Env validation (Pydantic settings)
├── db.py             # asyncpg pool + pgvector codec
├── redis_client.py   # Async Redis
├── agent.py          # Turn orchestrator (parallel RAG + SQL)
├── intent.py         # GPT-4o-mini intent + entity extraction
├── rag.py            # Embed → pgvector → rerank → ground
├── sql_agent.py      # Voice-to-SQL + validator + fallback
├── embeddings.py     # OpenAI embeddings + Redis cache
└── synthesis.py      # GPT-4o voice-first response
```

## Run locally

```bash
# From agent-api/
cp .env.example .env
# Edit .env — set OPENAI_API_KEY, DATABASE_URL, REDIS_URL
pip install -r requirements.txt
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

## Deploy to Railway

See `SLICE-2A-SETUP.md` at the repo root.
