-- 002_pgvector.sql — Enable pgvector and add embedding columns
--
-- Run AFTER 001_init.sql:
--   psql $DATABASE_URL -f migrations/002_pgvector.sql
--
-- pgvector is pre-installed on Railway's managed PostgreSQL.
-- If running locally, install it first: CREATE EXTENSION IF NOT EXISTS vector;

-- Enable the extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Add embedding columns (1536 dims = OpenAI text-embedding-3-small)
ALTER TABLE vehicles
  ADD COLUMN IF NOT EXISTS embedding vector(1536);

ALTER TABLE knowledge_chunks
  ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- HNSW index for fast approximate nearest neighbor search on vehicles
-- m=16: max connections per node (higher = better recall, more memory)
-- ef_construction=64: search width during build (higher = better recall, slower build)
CREATE INDEX IF NOT EXISTS vehicles_embedding_idx
  ON vehicles USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- HNSW index for knowledge chunks (FAQ, policies, etc.)
CREATE INDEX IF NOT EXISTS knowledge_chunks_embedding_idx
  ON knowledge_chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
