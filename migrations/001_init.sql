-- 001_init.sql — Core tables for Car Dealership Voice AI
--
-- Run ONCE on a fresh database:
--   psql $DATABASE_URL -f migrations/001_init.sql
--
-- Tables created:
--   vehicles        — inventory (core)
--   call_sessions   — per-call record
--   knowledge_chunks — RAG corpus (FAQ, policies, promos)
--   leads           — captured from conversations

-- Use gen_random_uuid() for PK defaults (built into PG 13+)

CREATE TABLE IF NOT EXISTS vehicles (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vin          VARCHAR(17) UNIQUE NOT NULL,
  make         VARCHAR(50)  NOT NULL,
  model        VARCHAR(100) NOT NULL,
  year         SMALLINT     NOT NULL,
  trim         VARCHAR(100),
  color_ext    VARCHAR(50),
  color_int    VARCHAR(50),
  mileage      INT,
  price        NUMERIC(10,2) NOT NULL,
  condition    VARCHAR(10) CHECK (condition IN ('new','used','cpo')),
  transmission VARCHAR(20),
  fuel_type    VARCHAR(20),
  body_style   VARCHAR(30),
  features     JSONB DEFAULT '[]'::JSONB,
  status       VARCHAR(20) DEFAULT 'available'
                 CHECK (status IN ('available','sold','hold')),
  description  TEXT,
  -- embedding column added in 002_pgvector.sql
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS call_sessions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vonage_call_id VARCHAR(50) UNIQUE,
  caller_number  VARCHAR(20),
  started_at     TIMESTAMPTZ DEFAULT now(),
  ended_at       TIMESTAMPTZ,
  transcript     TEXT,
  entities       JSONB DEFAULT '{}'::JSONB,
  outcome        VARCHAR(30)
                   CHECK (outcome IN ('answered','transferred','dropped','failed'))
);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source    VARCHAR(100) NOT NULL
              CHECK (source IN ('faq','policy','promo','financing','service')),
  content   TEXT NOT NULL,
  -- embedding column added in 002_pgvector.sql
  metadata  JSONB DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS leads (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id  UUID REFERENCES call_sessions(id) ON DELETE SET NULL,
  phone       VARCHAR(20),
  interests   JSONB DEFAULT '{}'::JSONB,
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- Trigger to auto-update updated_at on vehicles
CREATE OR REPLACE FUNCTION update_modified_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vehicles_updated_at ON vehicles;
CREATE TRIGGER vehicles_updated_at
  BEFORE UPDATE ON vehicles
  FOR EACH ROW EXECUTE FUNCTION update_modified_column();
