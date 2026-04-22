/**
 * DECAY WORKER (BACKGROUND PROCESS)
 * 
 * Detects and processes expired PENDING_ACK applications every 5-10 seconds.
 * Ensures applicants don't stay in limbo state indefinitely.
 */

import { Pool } from 'pg';
import { withTransaction, reindexQueuePositions, TransactionContext } from '../db/transactions';
import { logTransition } from './auditLog.service';
import { cascadePromotion } from './promotion.service';
import { AppError } from '../errors';

let workerInterval: NodeJS.Timeout | null = null;
let isRunning = false;
let lastRunAt: number | null = null;
let lastBatchSize: number = 0;

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
  // Handle AppError (custom error class with full context)
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

  // Handle standard Error objects
  if (err instanceof Error) {
    return {
      type: err.constructor.name,
      message: err.message,
      stack: err.stack,
    };
  }

  // Handle plain objects with error-like shape
  if (typeof err === 'object' && err !== null) {
    const objErr = err as Record<string, any>;
    return {
      type: objErr.name || 'UnknownError',
      message: objErr.message || 'Unknown worker error',
      code: objErr.code,
      stack: objErr.stack,
    };
  }

  // Fallback for primitive values or other unknown types
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
      console.error("[DECAY WORKER CRITICAL FAILURE] Uncaught exception processing decay interval:", err);
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
 * Find and lock expired PENDING_ACK applications for processing
 * Uses FOR UPDATE SKIP LOCKED to ensure multi-instance safety
 */
async function findExpiredApplications(ctx: TransactionContext): Promise<Array<{ id: string; job_id: string; penalty_count: number }>> {
  const result = await ctx.query(
    `SELECT id, job_id, penalty_count
     FROM applications
     WHERE status = 'PENDING_ACK' 
       AND ack_deadline < NOW()
     ORDER BY ack_deadline ASC
     FOR UPDATE SKIP LOCKED
     LIMIT 100`
  );
  return result.rows;
}

/**
 * Group expired applications by job ID for efficient batch processing
 */
function groupApplicationsByJob(
  apps: Array<{ id: string; job_id: string; penalty_count: number }>
): Map<string, Array<{ id: string; penalty_count: number }>> {
  const jobMap = new Map<string, Array<{ id: string; penalty_count: number }>>();
  
  for (const app of apps) {
    if (!jobMap.has(app.job_id)) {
      jobMap.set(app.job_id, []);
    }
    jobMap.get(app.job_id)!.push({ id: app.id, penalty_count: app.penalty_count });
  }
  
  return jobMap;
}

/**
 * Update statuses and queue positions for decayed applications
 */
async function updateDecayedApplicationStatuses(
  ctx: TransactionContext,
  jobId: string,
  appIds: string[]
): Promise<void> {
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
}

/**
 * Log state transitions for decayed applications (audit + observability)
 */
async function logDecayTransitions(
  ctx: TransactionContext,
  jobId: string,
  apps: Array<{ id: string; penalty_count: number }>
): Promise<void> {
  for (const app of apps) {
    // Audit Log (Database)
    await logTransition(ctx, app.id, 'PENDING_ACK', 'WAITLISTED', {
      reason: 'ack_deadline_expired',
      penalty_count: app.penalty_count + 1,
    });

    // Application Log (Observability)
    console.info("DECAY_PROCESSED", {
      appId: app.id,
      jobId,
      from: 'PENDING_ACK',
      to: 'WAITLISTED',
      penaltyApplied: true,
      timestamp: new Date().toISOString()
    });
  }
}

/**
 * Process a single job's decayed applications
 */
async function processJobDecayedApps(
  ctx: TransactionContext,
  jobId: string,
  apps: Array<{ id: string; penalty_count: number }>
): Promise<void> {
  const appIds = apps.map(a => a.id);
  
  // Update status and queue positions
  await updateDecayedApplicationStatuses(ctx, jobId, appIds);
  
  // Reindex queue positions
  await reindexQueuePositions(ctx, jobId);
  
  // Log all transitions
  await logDecayTransitions(ctx, jobId, apps);
  
  // Fill freed slots via cascade promotion
  await cascadePromotion(ctx, jobId);
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
export async function processDecayedApplications(pool: Pool): Promise<void> {
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
      // Find and lock expired applications
      const expiredApps = await findExpiredApplications(ctx);

      if (expiredApps.length === 0) {
        return; // No expired applications to process
      }

      errorContext.batchSize = expiredApps.length;
      lastBatchSize = expiredApps.length;
      lastRunAt = Date.now();

      // Group applications by job for batch processing
      const jobMap = groupApplicationsByJob(expiredApps);
      errorContext.jobIds = Array.from(jobMap.keys());

      // Process each job's decayed applications
      for (const [jobId, apps] of jobMap.entries()) {
        await processJobDecayedApps(ctx, jobId, apps);
      }
    });
  } catch (err) {
    logDecayWorkerError(err, errorContext);
    throw err; // Propagate error for visibility and monitoring
  } finally {
    isRunning = false;
  }
}

/**
 * Health check - return worker status
 */
export function getDecayWorkerHealth() {
  return {
    lastRunAt,
    lastBatchSize,
    isHealthy: lastRunAt ? (Date.now() - lastRunAt < 15000) : (!!workerInterval || isRunning),
  };
}
