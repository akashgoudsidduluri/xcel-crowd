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
import { withTransaction, TransactionContext, reindexQueuePositions, getJobForUpdate, getMaxQueuePosition } from '../db/transactions';
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
/**
 * Process all expired PENDING_ACK applications atomically
 * 
 * Uses SELECT FOR UPDATE SKIP LOCKED for efficiency and safety:
 * - Atomically claims expired applications
 * - Multiple instances don't re-process (SKIP LOCKED)
 * - Simple single transaction (no nested locks or advisory locks)
 * - Cascade promotion fills all freed slots immediately
 */
async function processDecayedApplications(pool: Pool): Promise<void> {
  if (isRunning) {
    return;
  }

  isRunning = true;

  try {
    // SINGLE TRANSACTION: Atomically decay expired apps and fill slots
    await withTransaction(pool, async (ctx) => {
      // STEP 1: Find and lock expired applications for this worker
      // FOR UPDATE SKIP LOCKED ensures:
      // - Other worker instances won't re-process these rows
      // - We only process what we can claim atomically
      const expiredAppsResult = await ctx.query(
        `SELECT id, job_id, penalty_count
         FROM applications
         WHERE status = 'PENDING_ACK' 
           AND ack_deadline < NOW()
         ORDER BY ack_deadline ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 100`
      );

      if (expiredAppsResult.rows.length === 0) {
        return; // No expired applications to process
      }

      // STEP 2: Group by job for batch processing
      const jobMap = new Map<string, Array<{ id: string; penalty_count: number }>>();
      for (const app of expiredAppsResult.rows) {
        if (!jobMap.has(app.job_id)) {
          jobMap.set(app.job_id, []);
        }
        jobMap.get(app.job_id)!.push({ id: app.id, penalty_count: app.penalty_count });
      }

      // STEP 3: Process each job (within same transaction)
      for (const [jobId, apps] of jobMap.entries()) {
        // Lock job for capacity check in cascade
        await getJobForUpdate(ctx, jobId);

        // Move expired apps to waitlist with penalty
        const appIds = apps.map(a => a.id);
        await ctx.query(
          `UPDATE applications
           SET status = 'WAITLISTED',
               penalty_count = penalty_count + 1,
               ack_deadline = NULL,
               updated_at = NOW()
           WHERE id = ANY($1)`,
          [appIds]
        );

        // Log transitions efficiently
        for (const app of apps) {
          await logTransition(ctx, app.id, 'PENDING_ACK', 'WAITLISTED', {
            reason: 'ack_deadline_expired',
            penalty_count: app.penalty_count + 1,
          });
        }

        // CRITICAL: Cascade promotion fills freed slots atomically
        // This is safe because everything is in ONE transaction
        await cascadePromotion(ctx, jobId);
      }
    });
  } catch (err) {
    console.error('[DECAY WORKER] Worker cycle failed:', err);
  } finally {
    isRunning = false;
  }
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
    isActive: !!workerInterval,
  };
}
