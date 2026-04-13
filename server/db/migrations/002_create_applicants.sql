-- Migration: Create applicants table
CREATE TABLE IF NOT EXISTS applicants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_applicants_email ON applicants(email);
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

