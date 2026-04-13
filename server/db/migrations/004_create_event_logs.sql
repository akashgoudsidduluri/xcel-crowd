-- Migration: Create event_logs table
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

