/**
 * ============================================================================
 * DECAY WORKER (BACKGROUND PROCESS)
 * ============================================================================
 * 
 * Runs every 5-10 seconds to detect and process expired PENDING_ACK applications
 * 
 * CRITICAL LOGIC:
 * 1. Find PENDING_ACK where ack_deadline < NOW()
 * 2. Transition PENDING_ACK → WAITLISTED
 * 3. Increment penalty_count
 * 4. Add penalty to queue_position (move to end + penalty)
 * 5. Trigger cascade promotion
 * 6. Log all transitions
 * 
 * Each application processed in separate transaction for atomicity
 */

import { Pool } from 'pg';
import { withTransaction, TransactionContext, getExpiredPendingAck, reindexQueuePositions, getJobForUpdate } from '../db/transactions';
import { validateTransition } from '../stateMachine';
import { logTransition } from './auditLog.service';
import { cascadePromotion } from './promotion.service';

let workerInterval: NodeJS.Timeout | null = null;
let isRunning = false;

/**
 * Start the decay worker
 * Runs every 5 seconds (configurable)
 */
export function startDecayWorker(
  pool: Pool,
  intervalMs: number = 5000
): void {
  if (workerInterval) {
    console.warn('[DECAY WORKER] Already running');
    return;
  }

  console.log(`[DECAY WORKER] Starting with ${intervalMs}ms interval`);

  workerInterval = setInterval(() => {
    processDecayedApplications(pool).catch((err) => {
      console.error('[DECAY WORKER] Error during processing:', err.message);
    });
  }, intervalMs);
}

/**
 * Stop the decay worker
 */
export function stopDecayWorker(): void {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
    console.log('[DECAY WORKER] Stopped');
  }
}

/**
 * Process all expired PENDING_ACK applications (batched for efficiency)
 * 
 * Row locking (FOR UPDATE SKIP LOCKED) ensures multi-instance safety:
 * - Only one worker instance claims each row
 * - Other instances skip locked rows, move on
 * - No double-processing across multiple servers
 * 
 * Batches in chunks of 100 to avoid long transactions
 */
async function processDecayedApplications(pool: Pool): Promise<void> {
  if (isRunning) {
    return;
  }

  isRunning = true;

  try {
    // STEP 1: Multi-instance safety (Advisory lock)
    // Runs outside the job loop to prevent multiple workers from running at once
    const advisoryLockObtained = await withTransaction(pool, async (ctx) => {
      const lockResult = await ctx.query('SELECT pg_try_advisory_lock(12345) as obtained');
      return lockResult.rows[0].obtained;
    });

    if (!advisoryLockObtained) return;

    // STEP 2: Find jobs with expired applications (NO LOCK yet)
    const affectedJobsResult = await pool.query(
      `SELECT DISTINCT job_id 
       FROM applications 
       WHERE status = 'PENDING_ACK' AND ack_deadline < NOW()
       LIMIT 10` // Process 10 jobs per cycle for safety
    );

    if (affectedJobsResult.rows.length === 0) return;

    // STEP 3: Process each job independently with correct lock order
    for (const { job_id } of affectedJobsResult.rows) {
      try {
        await withTransaction(pool, async (ctx) => {
          // LOCK ORDER: 1. Job, 2. Application
          // 1. Lock Job
          await getJobForUpdate(ctx, job_id);

          // 2. Lock specific expired applications for this job
          const expiredApps = await ctx.query(
            `SELECT id, job_id, status, penalty_count
             FROM applications
             WHERE job_id = $1 AND status = 'PENDING_ACK' AND ack_deadline < NOW()
             FOR UPDATE SKIP LOCKED
             LIMIT 50`,
            [job_id]
          );

          if (expiredApps.rows.length === 0) return;

          // 3. Process the decay
          for (const app of expiredApps.rows) {
            await processExpiredApplicationInternal(ctx, app);
          }

          // 4. Trigger cascade promotion (Inside the same TX)
          await cascadePromotion(ctx, job_id);
        });
      } catch (err) {
        console.error(`[DECAY WORKER] Failed to process job ${job_id}:`, err);
      }
    }
  } catch (err) {
    console.error('[DECAY WORKER] Worker cycle failed:', err);
  } finally {
    isRunning = false;
  }
}

/**
 * Internal logic for processing a single expired application
 * MUST be called inside a transaction
 */
async function processExpiredApplicationInternal(
  ctx: TransactionContext,
  app: any
): Promise<void> {
  // Idempotency check 
  if (app.status !== 'PENDING_ACK') return;

  // STEP 1: Validate transition
  validateTransition('PENDING_ACK', 'WAITLISTED');

  // STEP 2: Increment penalty
  const currentPenalty = app.penalty_count || 0;
  const newPenalty = currentPenalty + 1;

  // STEP 3: Get max position for job
  const maxPos = await getMaxQueuePosition(ctx, app.job_id);
  const newQueuePosition = maxPos + 1 + newPenalty;

  // STEP 4: Move to WAITLISTED
  await ctx.query(
    `UPDATE applications
     SET status = $1, queue_position = $2, penalty_count = $3, ack_deadline = NULL, updated_at = NOW()
     WHERE id = $4`,
    ['WAITLISTED', newQueuePosition, newPenalty, app.id]
  );

  // STEP 5: Reindex queue
  await reindexQueuePositions(ctx, app.job_id);

  // STEP 6: Log transition
  await logTransition(ctx, app.id, 'PENDING_ACK', 'WAITLISTED', {
    reason: 'acknowledgment_deadline_expired',
    penaltyCount: newPenalty,
  });
}

/**
 * Health check - return worker status
 */
export function getWorkerStatus(): {
  isRunning: boolean;
  isActive: boolean;
} {
  return {
    isRunning: !!workerInterval,
    isActive,
  };
}
