/**
 * ============================================================================
 * DATABASE TRANSACTION & LOCKING UTILITIES
 * ============================================================================
 * 
 * CRITICAL FOR CONCURRENCY:
 * - Wraps all mutations in transactions
 * - Enforces SELECT ... FOR UPDATE for capacity control
 * - Enforces FOR UPDATE SKIP LOCKED for queue safety
 * - Prevents race conditions and double-booking
 */

import { Pool } from 'pg';
import { AppError, ERROR_CODES } from '../errors';
import { TransactionContext, ExpiredPendingAckApplication } from './types';
import { ApplicationStatus } from '../stateMachine';

import { WaitlistedApplicationRow } from './types';

// Re-export TransactionContext for convenience (also defined in ./types)
export { TransactionContext, WaitlistedApplicationRow } from './types';

export interface InternalTransactionContext extends TransactionContext {
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
}

/**
 * Start a new transaction
 * All database operations MUST use ctx.query() to ensure they're in transaction
 */
export async function beginTransaction(pool: Pool): Promise<InternalTransactionContext> {
  const client = await pool.connect();
  
  try {
    await client.query('BEGIN');
    
    // Set statement timeout to 30 seconds per statement
    // Prevents long-running cascades from holding connections indefinitely
    await client.query('SET LOCAL statement_timeout = \'30s\'');
  } catch (err) {
    client.release();
    throw err;
  }

  return {
    query: (text: string, values?: any[]) => client.query(text, values),
    commit: async () => {
      await client.query('COMMIT');
      client.release();
    },
    rollback: async () => {
      await client.query('ROLLBACK');
      client.release();
    },
  };
}

/**
 * Execute function inside a transaction with automatic rollback on error
 * USE THIS PATTERN FOR ALL MUTATIONS:
 * 
 *   const result = await withTransaction(pool, async (ctx) => {
 *     const app = await ctx.query('SELECT ...', []);
 *     await ctx.query('UPDATE ...', []);
 *     return app;
 *   });
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (ctx: TransactionContext) => Promise<T>
): Promise<T> {
  const ctx = await beginTransaction(pool);

  try {
    const result = await fn(ctx);
    await ctx.commit();
    return result;
  } catch (err) {
    await ctx.rollback();
    throw err;
  }
}

/**
 * ============================================================================
 * LOCKING QUERIES
 * ============================================================================
 * 
 * Critical for capacity control and queue safety
 */

/**
 * Get job with FOR UPDATE lock
 * Used during apply flow to ensure capacity is not exceeded
 * 
 * MUST be called inside transaction
 */
export async function getJobForUpdate(
  ctx: TransactionContext,
  jobId: string
): Promise<{ id: string; title: string; capacity: number; ack_timeout_seconds?: number }> {
  const result = await ctx.query(
    'SELECT id, title, capacity, ack_timeout_seconds FROM jobs WHERE id = $1 FOR UPDATE',
    [jobId]
  );
  
  if (result.rows.length === 0) {
    throw new AppError(
      `Job with ID ${jobId} not found`,
      404,
      ERROR_CODES.JOB_NOT_FOUND
    );
  }
  
  return result.rows[0];
}

/**
 * Get next WAITLISTED application with FOR UPDATE SKIP LOCKED
 * Used during promotion to ensure only one process promotes the same applicant
 * 
 * SKIP LOCKED: If row is already locked by another transaction, skip it
 * This prevents blocking and duplicate promotions
 */
export async function getNextWaitlistedForPromotion(
  ctx: TransactionContext,
  jobId: string
): Promise<WaitlistedApplicationRow | null> {
  const result = await ctx.query(
    `SELECT id, applicant_id, queue_position, penalty_count
     FROM applications
     WHERE job_id = $1 AND status = 'WAITLISTED'
     ORDER BY queue_position ASC, created_at ASC, id ASC
     LIMIT 1
     FOR UPDATE SKIP LOCKED`,
    [jobId]
  );
  
  return result.rows[0] || null;
}

/**
 * Count ACTIVE and PENDING_ACK applications (capacity check)
 * MUST be called inside transaction after job lock
 */
export async function countActiveAndPendingAck(
  ctx: TransactionContext,
  jobId: string
): Promise<number> {
  const result = await ctx.query(
    `SELECT COUNT(*) as count
     FROM applications
     WHERE job_id = $1 AND status IN ('ACTIVE', 'PENDING_ACK')`,
    [jobId]
  );
  
  return parseInt(result.rows[0].count, 10);
}

/**
 * Check for duplicate application
 * (Same applicant applying to same job multiple times)
 * MUST be called inside transaction
 */
export async function checkDuplicateApplication(
  ctx: TransactionContext,
  jobId: string,
  applicantId: number | string
): Promise<boolean> {
  const result = await ctx.query(
    'SELECT 1 FROM applications WHERE job_id = $1 AND applicant_id = $2 LIMIT 1',
    [jobId, applicantId]
  );
  
  return result.rows.length > 0;
}

/**
 * Get maximum queue position for a job
 * Used when adding to waitlist
 */
export async function getMaxQueuePosition(
  ctx: TransactionContext,
  jobId: string
): Promise<number> {
  const result = await ctx.query(
    `SELECT MAX(queue_position) as max_pos
     FROM applications
     WHERE job_id = $1 AND status = 'WAITLISTED'`,
    [jobId]
  );
  
  return parseInt(result.rows[0].max_pos || 0, 10);
}

/**
 * Reindex queue positions for a job
 * ENSURES contiguous positions: 1, 2, 3, ...
 * SINGLE QUERY - NOT a loop
 * 
 * Uses ROW_NUMBER() window function to reindex all WAITLISTED in one atomic operation
 */
export async function reindexQueuePositions(
  ctx: TransactionContext,
  jobId: string
): Promise<void> {
  await ctx.query(
    `WITH ranked AS (
       SELECT id,
              ROW_NUMBER() OVER (
                ORDER BY queue_position ASC NULLS LAST, created_at ASC, id ASC
              ) AS rn
       FROM applications
       WHERE job_id = $1 AND status = 'WAITLISTED'
     )
     UPDATE applications a
     SET queue_position = r.rn
     FROM ranked r
     WHERE a.id = r.id`,
    [jobId]
  );
}

/**
 * Get current queue state for a job
 * Returns all WAITLISTED with positions for transparency
 */
export async function getQueueState(
  ctx: TransactionContext,
  jobId: string
): Promise<WaitlistedApplicationRow[]> {
  const result = await ctx.query(
    `SELECT id, applicant_id, queue_position, penalty_count, created_at
     FROM applications
     WHERE job_id = $1 AND status = 'WAITLISTED'
     ORDER BY queue_position ASC, created_at ASC, id ASC`,
    [jobId]
  );
  
  return result.rows;
}

/**
 * Find applicant by email (or create if not exists)
 * Returns applicant_id
 * 
 * ATOMIC UPSERT: No race condition between SELECT and INSERT
 * Guaranteed to return the applicant id in one round trip
 * MUST be called inside transaction
 */
export async function findOrCreateApplicant(
  ctx: TransactionContext,
  email: string,
  name: string
): Promise<string> {
  // UPSERT: Atomic at database level
  // If email exists: returns existing id
  // If email new: inserts and returns new id
  // No race condition possible
  const result = await ctx.query(
    `INSERT INTO applicants (email, name)
     VALUES ($1, $2)
     ON CONFLICT (email)
     DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [email, name]
  );
  
  return result.rows[0].id;
}

/**
 * Get application by ID (for reads)
 */
export async function getApplication(
  ctx: TransactionContext,
  applicationId: string
): Promise<any> {
  const result = await ctx.query(
    `SELECT id, job_id, applicant_id, status, queue_position, ack_deadline, penalty_count, created_at, updated_at
     FROM applications
     WHERE id = $1`,
    [applicationId]
  );
  
  if (result.rows.length === 0) {
    throw new AppError(
      `Application with ID ${applicationId} not found`,
      404,
      ERROR_CODES.APP_NOT_FOUND
    );
  }
  
  return result.rows[0];
}

/**
 * Get application with FOR UPDATE lock
 * MUST be called inside transaction
 */
export async function getApplicationForUpdate(
  ctx: TransactionContext,
  applicationId: string
): Promise<any> {
  const result = await ctx.query(
    `SELECT id, job_id, applicant_id, status, queue_position, ack_deadline, penalty_count, created_at, updated_at
     FROM applications
     WHERE id = $1 FOR UPDATE`,
    [applicationId]
  );
  
  if (result.rows.length === 0) {
    throw new AppError(
      `Application with ID ${applicationId} not found`,
      404,
      ERROR_CODES.APP_NOT_FOUND
    );
  }
  
  return result.rows[0];
}

/**
 * Get expired applications (PENDING_ACK past deadline) with row locking
 * For decay worker - ensures each row is claimed by only one worker
 * 
 * Uses FOR UPDATE SKIP LOCKED for multi-instance safety:
 * - If another worker has row locked, skip it (doesn't block)
 * - Only one worker processes each batch
 * - Batched in chunks of 100 to avoid long transactions
 */
export async function getExpiredPendingAck(
  ctx: TransactionContext,
  batchSize: number = 100
): Promise<ExpiredPendingAckApplication[]> {
  const result = await ctx.query(
    `SELECT id, job_id, applicant_id, status, queue_position, penalty_count
     FROM applications
     WHERE status = 'PENDING_ACK' AND ack_deadline < NOW()
     ORDER BY ack_deadline ASC
     LIMIT $1
     FOR UPDATE SKIP LOCKED`,
    [batchSize]
  );
  
  return result.rows;
}

/**
 * Count applications by status for a job
 * For monitoring/debugging
 */
export async function countByStatus(
  ctx: TransactionContext,
  jobId: string
): Promise<Record<ApplicationStatus, number>> {
  const result = await ctx.query(
    `SELECT status, COUNT(*) as count
     FROM applications
     WHERE job_id = $1
     GROUP BY status`,
    [jobId]
  );
  
  const counts: Record<string, number> = {};
  result.rows.forEach((row) => {
    counts[row.status] = parseInt(row.count, 10);
  });
  
  return counts as Record<ApplicationStatus, number>;
}
