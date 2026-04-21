-- Migration: Create applications table with strict state machine
-- 
-- STRICT STATE MACHINE:
-- WAITLISTED → PENDING_ACK → ACTIVE → HIRED/REJECTED
--                         → INACTIVE (withdraw)
--           → INACTIVE (withdraw)
--
-- PENDING_ACK is MANDATORY - no direct ACTIVE during apply
-- INACTIVE is terminal state (replaces separate WITHDRAWN)

-- First, drop table if it exists (CASCADE will handle dependent objects)
DROP TABLE IF EXISTS applications CASCADE;

-- Now forcefully drop and recreate the enum type
-- We need to do this in a transaction to ensure clean state
DO $$ 
DECLARE
  v_type_exists boolean;
BEGIN
  -- Check if type exists
  SELECT EXISTS(SELECT 1 FROM pg_type WHERE typname = 'application_status') INTO v_type_exists;
  
  IF v_type_exists THEN
    -- Force drop with CASCADE if it exists
    EXECUTE 'DROP TYPE IF EXISTS application_status CASCADE';
  END IF;
  
  -- Now create the new type
  CREATE TYPE application_status AS ENUM (
    'WAITLISTED',
    'PENDING_ACK',
    'ACTIVE',
    'INACTIVE',
    'HIRED',
    'REJECTED'
  );
END $$;

CREATE TABLE IF NOT EXISTS applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  applicant_id UUID NOT NULL REFERENCES applicants(id) ON DELETE CASCADE,
  status application_status NOT NULL DEFAULT 'WAITLISTED',
  queue_position INT,
  ack_deadline TIMESTAMP WITH TIME ZONE,
  penalty_count INT NOT NULL DEFAULT 0 CHECK (penalty_count >= 0),
  last_transition_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT valid_queue_position CHECK (queue_position IS NULL OR queue_position > 0),
  CONSTRAINT unique_application_per_job UNIQUE(job_id, applicant_id)
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
  CREATE INDEX IF NOT EXISTS idx_applications_pending_ack ON applications(ack_deadline) WHERE status = 'PENDING_ACK';
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;
DO $$ BEGIN
  CREATE INDEX IF NOT EXISTS idx_applications_applicant ON applications(applicant_id);
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

