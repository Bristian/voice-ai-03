-- 003_indexes.sql — Composite B-tree indexes for SQL filtering
--
-- Run AFTER 002_pgvector.sql:
--   psql $DATABASE_URL -f migrations/003_indexes.sql

-- Partial index on available vehicles — covers the Voice-to-SQL WHERE clause
CREATE INDEX IF NOT EXISTS idx_vehicles_search
  ON vehicles (make, model, year, price, status)
  WHERE status = 'available';

-- For body_style + price range queries ("SUV under $30k")
CREATE INDEX IF NOT EXISTS idx_vehicles_body_price
  ON vehicles (body_style, price)
  WHERE status = 'available';

-- For call session lookup by Vonage call ID
CREATE INDEX IF NOT EXISTS idx_sessions_vonage_call
  ON call_sessions (vonage_call_id);

-- For knowledge chunk filtering by source type
CREATE INDEX IF NOT EXISTS idx_knowledge_source
  ON knowledge_chunks (source);

-- For leads by creation date (dashboard queries)
CREATE INDEX IF NOT EXISTS idx_leads_created
  ON leads (created_at DESC);
