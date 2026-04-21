import { Pool } from 'pg';

/**
 * Create database pool with hardened timeout settings
 */
export const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '5432', 10),
  database: process.env.DB_NAME || 'next_in_line',
  connectionString: process.env.DATABASE_URL, // Overrides other settings if provided
  // Connection pool settings
  max: 20,                           // Max connections
  min: 2,                            // Min connections
  idleTimeoutMillis: 30000,          // Close idle connections after 30s
  connectionTimeoutMillis: 2000,     // Fail fast if no connection available
  statement_timeout: 5000,           // 5s statement timeout (per requirement)
  query_timeout: 30000,              // Query timeout (fallback)
});

/**
 * Run database migrations
 */
export async function runMigrations(): Promise<void> {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;

    CREATE TABLE IF NOT EXISTS jobs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title TEXT NOT NULL,
      capacity INTEGER NOT NULL CHECK (capacity > 0),
      active_count INTEGER NOT NULL DEFAULT 0 CHECK (active_count >= 0),
      ack_timeout_seconds INTEGER NOT NULL DEFAULT 30 CHECK (ack_timeout_seconds > 0),
      created_by TEXT,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS applicants (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );

    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'application_status') THEN
        CREATE TYPE application_status AS ENUM (
          'WAITLISTED',
          'PENDING_ACK',
          'ACTIVE',
          'INACTIVE',
          'HIRED',
          'REJECTED'
        );
      END IF;
    END $$;

    CREATE TABLE IF NOT EXISTS applications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      applicant_id UUID NOT NULL REFERENCES applicants(id) ON DELETE CASCADE,
      status application_status NOT NULL DEFAULT 'WAITLISTED',
      queue_position INTEGER,
      ack_deadline TIMESTAMP WITH TIME ZONE,
      penalty_count INTEGER NOT NULL DEFAULT 0 CHECK (penalty_count >= 0),
      last_transition_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      UNIQUE(job_id, applicant_id)
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      application_id UUID NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
      from_status TEXT,
      to_status TEXT NOT NULL,
      metadata JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
  `);
}
