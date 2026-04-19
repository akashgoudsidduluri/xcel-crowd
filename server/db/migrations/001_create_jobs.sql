-- Migration: Create jobs table
CREATE TABLE IF NOT EXISTS jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  capacity INT NOT NULL CHECK (capacity > 0),
  active_count INT NOT NULL DEFAULT 0 CHECK (active_count >= 0),
  created_by TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at);
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

