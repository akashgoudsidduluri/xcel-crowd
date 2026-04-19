-- Migration: Create applicants table
-- Applicants are identified by UNIQUE email
-- Same applicant can apply to multiple jobs
-- Constraint: UNIQUE(job_id, applicant_id) prevents duplicate applications per job

CREATE TABLE IF NOT EXISTS applicants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_applicants_email ON applicants(email);
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

