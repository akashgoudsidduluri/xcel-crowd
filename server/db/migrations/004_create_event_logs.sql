-- Migration: Create audit_logs table (MANDATORY LOGGING)
-- 
-- CRITICAL: EVERY state transition must be logged here.
-- System must be reconstructable from these logs.
-- Logs are IMMUTABLE (no updates, only inserts).

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_audit_logs_app ON audit_logs(application_id);
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_audit_logs_timestamp ON audit_logs(created_at);
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_audit_logs_transition ON audit_logs(from_status, to_status);
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

-- Keep event_logs for backward compatibility if needed
-- But prefer audit_logs for all new code
CREATE TABLE IF NOT EXISTS event_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  metadata JSONB
);

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_event_logs_app ON event_logs(application_id);
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_event_logs_timestamp ON event_logs(timestamp);
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_event_logs_status ON event_logs(from_status, to_status);
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

