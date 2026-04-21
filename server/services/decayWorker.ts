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
 * 4. Reinsert expired applicants at the queue tail in deterministic order
 * 5. Trigger cascade promotion
 * 6. Log all transitions
 */

import { Pool } from 'pg';
import { withTransaction, reindexQueuePositions, getJobForUpdate } from '../db/transactions';
import { logTransition } from './auditLog.service';
import { cascadePromotion } from './promotion.service';
import { AppError } from '../errors';

let workerInterval: NodeJS.Timeout | null = null;
let isRunning = false;

type DecayWorkerErrorContext = {
  batchSize: number;
  jobIds: string[];
};

interface StructuredError {
  type: string;
  message: string;
  code?: string;
  statusCode?: number;
  details?: Record<string, any>;
  stack?: string;
}

function structureError(err: unknown): StructuredError {
  if (err instanceof AppError) {
    return {
      type: err.name,
      message: err.message,
      code: err.code,
      statusCode: err.statusCode,
      details: err.details,
      stack: err.stack,
    };
  }
  
  if (err instanceof Error) {
    return {
      type: err.constructor.name,
      message: err.message,
      stack: err.stack,
    };
  }
  
  if (typeof err === 'object' && err !== null) {
    const objErr = err as Record<string, any>;
    return {
      type: objErr.name || 'UnknownError',
      message: objErr.message || 'Unknown worker error',
      code: objErr.code,
      stack: objErr.stack,
    };
  }
  
  return {
    type: 'UnknownError',
    message: String(err),
  };
}

function logDecayWorkerError(
  err: unknown,
  context: DecayWorkerErrorContext
): void {
  const timestamp = new Date().toISOString();
  const structuredError = structureError(err);

  console.error({
    event: 'DECAY_WORKER_ERROR',
    timestamp,
    error: structuredError,
    jobId: context.jobIds?.length ? context.jobIds[0] : undefined,
    metadata: {
      batchSize: context.batchSize,
      jobIds: context.jobIds,
    }
  });
}

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
      logDecayWorkerError(err, {
        batchSize: 0,
        jobIds: [],
      });
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
 * Process all expired PENDING_ACK applications atomically
 * 
 * Uses PostgreSQL row-level locking for efficiency and safety:
 * - Atomically claims expired applications
 * - FOR UPDATE SKIP LOCKED ensures multi-instance safety (no double-processing)
 * - Batches in chunks of 100 to balance throughput and transaction length
 * - Simple single transaction (no nested locks or advisory locks)
 * - Cascade promotion fills all freed slots immediately
 */
async function processDecayedApplications(pool: Pool): Promise<void> {
  if (isRunning) {
    return;
  }

  isRunning = true;
  const errorContext: DecayWorkerErrorContext = {
    batchSize: 0,
    jobIds: [],
  };

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

      errorContext.batchSize = expiredAppsResult.rows.length;

      // STEP 2: Group by job for batch processing
      const jobMap = new Map<string, Array<{ id: string; penalty_count: number }>>();
      for (const app of expiredAppsResult.rows) {
        if (!jobMap.has(app.job_id)) {
          jobMap.set(app.job_id, []);
        }
        jobMap.get(app.job_id)!.push({ id: app.id, penalty_count: app.penalty_count });
      }
      errorContext.jobIds = Array.from(jobMap.keys());

      // STEP 3: Process each job (within same transaction)
      for (const [jobId, apps] of jobMap.entries()) {
        // Lock job for capacity check in cascade
        await getJobForUpdate(ctx, jobId);

        // Move expired apps to the back of the queue in claimed order.
        const appIds = apps.map(a => a.id);
        await ctx.query(
          `WITH decayed_applications AS (
             SELECT id::uuid, ordinality
             FROM unnest($1::uuid[]) WITH ORDINALITY AS t(id, ordinality)
           )
           UPDATE applications a
           SET status = 'WAITLISTED',
               penalty_count = a.penalty_count + 1,
               queue_position = (SELECT COALESCE(MAX(queue_position), 0) FROM applications WHERE job_id = $2 AND status = 'WAITLISTED') + d.ordinality,
               ack_deadline = NULL,
               updated_at = NOW()
           FROM decayed_applications d
           WHERE a.id = d.id`,
          [appIds, jobId]
        );

        // FIX: Ensure queue is repaired and slots are filled in ONE transaction
        await reindexQueuePositions(ctx, jobId);

        // Log transitions efficiently
        for (const app of apps) {
          // Audit Log (Database)
          await logTransition(ctx, app.id, 'PENDING_ACK', 'WAITLISTED', {
            reason: 'ack_deadline_expired',
            penalty_count: app.penalty_count + 1,
          });

          // Application Log (Observability)
          console.log(JSON.stringify({
            event: 'DECAY_PROCESSED',
            appId: app.id,
            jobId,
            from: 'PENDING_ACK',
            to: 'WAITLISTED',
            penaltyApplied: true,
            timestamp: new Date().toISOString()
          }));
        }

        // CRITICAL: Cascade promotion fills freed slots atomically
        // This is safe because everything is in ONE transaction
        await cascadePromotion(ctx, jobId);
      }
    });
  } catch (err) {
    logDecayWorkerError(err, errorContext);
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
