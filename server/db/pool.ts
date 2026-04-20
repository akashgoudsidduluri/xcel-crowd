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
  // Migration logic would go here
  // For now, just ensure tables exist
  await pool.query(`
    CREATE TABLE IF NOT EXISTS jobs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      title TEXT NOT NULL,
      capacity INTEGER NOT NULL CHECK (capacity > 0),
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS applicants (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS applications (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      applicant_id UUID NOT NULL REFERENCES applicants(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'PENDING',
      queue_position INTEGER,
      applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
      acknowledged_at TIMESTAMP WITH TIME ZONE,
      UNIQUE(job_id, applicant_id)
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      application_id UUID REFERENCES applications(id) ON DELETE CASCADE,
      from_status TEXT,
      to_status TEXT,
      metadata JSONB,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
  `);
}