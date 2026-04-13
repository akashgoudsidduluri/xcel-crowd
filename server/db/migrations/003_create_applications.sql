-- Migration: Create applications table
DO $$ BEGIN
  CREATE TYPE application_status AS ENUM (
    'APPLIED',
    'WAITLISTED',
    'ACTIVE',
    'DECAYED',
    'REJECTED',
    'HIRED'
  );
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

CREATE TABLE IF NOT EXISTS applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  applicant_id UUID NOT NULL REFERENCES applicants(id) ON DELETE CASCADE,
  status application_status NOT NULL DEFAULT 'APPLIED',
  queue_position INT,
  ack_deadline TIMESTAMP,
  last_transition_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT valid_queue_position CHECK (queue_position IS NULL OR queue_position >= 0)
);

DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_applications_job_status ON applications(job_id, status);
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_applications_job_queue ON applications(job_id, queue_position) WHERE status = 'WAITLISTED';
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_applications_ack_deadline ON applications(ack_deadline) WHERE status = 'ACTIVE';
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_applications_applicant ON applications(applicant_id);
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

