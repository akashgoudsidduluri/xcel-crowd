/**
 * ============================================================================
 * PROMOTION SERVICE (QUEUE MANAGEMENT)
 * ============================================================================
 * 
 * CRITICAL LOGIC:
 * 1. Use FOR UPDATE SKIP LOCKED to prevent duplicate promotions
 * 2. Promote in queue_position order (lowest first)
 * 3. Reindex queue with single SQL query (ROW_NUMBER)
 * 4. Support cascade promotion (fill all available slots)
 * 5. Log every promotion transition
 */

import { Pool } from 'pg';
import { withTransaction, TransactionContext, getNextWaitlistedForPromotion, countActiveAndPendingAck, reindexQueuePositions, getJobForUpdate } from '../db/transactions';
import { validateTransition } from '../stateMachine';
import { logTransition } from './auditLog.service';
import { AppError } from '../errors';


/**
 * ============================================================================
 * PROMOTE NEXT (SINGLE PROMOTION)
 * ============================================================================
 * 
 * Atomically:
 * 1. Lock job and get capacity
 * 2. Count current ACTIVE + PENDING_ACK
 * 3. If capacity available, get next WAITLISTED with FOR UPDATE SKIP LOCKED
 * 4. If found, move to PENDING_ACK with new deadline
 * 5. Reindex queue positions
 * 6. Log transition
 * 
 * Returns the promoted application or null if no promotion happened
 */
export async function promoteNext(
  ctx: TransactionContext,
  jobId: string
): Promise<{
  applicationId: string;
  applicantId: string;
  ackDeadline: string;
  newQueueSize: number;
} | null> {
  // STEP 1: Lock job
  const job = await getJobForUpdate(ctx, jobId);

  // STEP 2: Count current occupants
  const currentCount = await countActiveAndPendingAck(ctx, jobId);

  // STEP 3: Check if capacity available
  if (currentCount >= job.capacity) {
    return null; // No capacity, cannot promote
  }

  // STEP 4: Get next WAITLISTED with FOR UPDATE SKIP LOCKED
  const nextApp = await getNextWaitlistedForPromotion(ctx, jobId);

  if (!nextApp) {
    return null; // No waitlist, cannot promote
  }

  // STEP 5: Validate transition
  validateTransition('WAITLISTED', 'PENDING_ACK');

  // STEP 6: Calculate new deadline (using job configuration)
  const timeoutSeconds = job.ack_timeout_seconds || 30;
  const deadline = new Date();
  deadline.setSeconds(deadline.getSeconds() + timeoutSeconds);
  const ackDeadline = deadline.toISOString();

  // STEP 7: Move to PENDING_ACK
  await ctx.query(
    `UPDATE applications
     SET status = $1, queue_position = NULL, ack_deadline = $2, updated_at = NOW()
     WHERE id = $3`,
    ['PENDING_ACK', ackDeadline, nextApp.id]
  );

  // STEP 8: Reindex queue (ensure contiguous positions)
  await reindexQueuePositions(ctx, jobId);

  // STEP 9: Get new queue size
  const queueResult = await ctx.query(
    'SELECT COUNT(*) as count FROM applications WHERE job_id = $1 AND status = $2',
    [jobId, 'WAITLISTED']
  );
  const newQueueSize = parseInt(queueResult.rows[0].count, 10);

  // STEP 10: Log transition
  await logTransition(ctx, nextApp.id, 'WAITLISTED', 'PENDING_ACK', {
    reason: 'automatic_promotion_from_waitlist',
    capacity: job.capacity,
    currentOccupancy: currentCount + 1, // Including this one
    nextQueuePosition: 1, // Reindexed, so first is now 1
    ackDeadline,
  });

  return {
    applicationId: nextApp.id,
    applicantId: nextApp.applicant_id,
    ackDeadline,
    newQueueSize,
  };
}

/**
 * ============================================================================
 * CASCADE PROMOTION (FILL ALL AVAILABLE SLOTS)
 * ============================================================================
 * 
 * Repeatedly calls promoteNext until:
 * - Capacity is full, OR
 * - Waitlist is empty
 * 
 * Each promotion is done in a separate transaction to avoid long locks
 */
export async function cascadePromotion(
  ctx: TransactionContext,
  jobId: string
): Promise<{
  promoted: Array<{ applicationId: string; applicantId: string }>;
  totalPromoted: number;
  remainingInWaitlist: number;
}> {
  // STEP 1: Get job capacity using the locking query
  const job = await getJobForUpdate(ctx, jobId);
  const capacity = job.capacity;

  // STEP 2: Count current active + pending ack
  const currentCountResult = await ctx.query(
    `SELECT COUNT(*) as count FROM applications
     WHERE job_id = $1 AND status IN ('ACTIVE', 'PENDING_ACK')`,
    [jobId]
  );
  const currentCount = parseInt(currentCountResult.rows[0].count, 10);
  const availableSlots = capacity - currentCount;

  if (availableSlots <= 0) {
    // No capacity available
    const waitlistResult = await ctx.query(
      `SELECT COUNT(*) as count FROM applications WHERE job_id = $1 AND status = 'WAITLISTED'`,
      [jobId]
    );
    return {
      promoted: [],
      totalPromoted: 0,
      remainingInWaitlist: parseInt(waitlistResult.rows[0].count, 10),
    };
  }

  // STEP 3: Promote the next N applications in queue order using a single query
  const timeoutSeconds = job.ack_timeout_seconds || 30;
  const promoteResult = await ctx.query(
    `WITH ranked_waitlist AS (
       SELECT id, applicant_id,
              ROW_NUMBER() OVER (ORDER BY queue_position ASC, created_at ASC) as rank
       FROM applications
       WHERE job_id = $1 AND status = 'WAITLISTED'
     ),
     to_promote AS (
       SELECT id, applicant_id FROM ranked_waitlist WHERE rank <= $2
     )
     UPDATE applications
     SET status = 'PENDING_ACK',
         ack_deadline = NOW() + ($3 || ' seconds')::INTERVAL,
         updated_at = NOW()
     WHERE id IN (SELECT id FROM to_promote)
     RETURNING id, applicant_id`,
    [jobId, availableSlots, timeoutSeconds]
  );

  const promoted = promoteResult.rows.map(row => ({
    applicationId: row.id,
    applicantId: row.applicant_id,
  }));

  // STEP 4: Log transitions for each promoted application
  for (const app of promoted) {
    await logTransition(ctx, app.applicationId, 'WAITLISTED', 'PENDING_ACK', {
      reason: 'cascade_promotion',
    });
  }

  // STEP 5: Get final waitlist count
  const finalWaitlistResult = await ctx.query(
    `SELECT COUNT(*) as count FROM applications WHERE job_id = $1 AND status = 'WAITLISTED'`,
    [jobId]
  );

  return {
    promoted,
    totalPromoted: promoted.length,
    remainingInWaitlist: parseInt(finalWaitlistResult.rows[0].count, 10),
  };
}

/**
 * Get queue statistics for a job
 */
export async function getQueueStats(
  pool: Pool,
  jobId: string
): Promise<{
  capacity: number;
  active: number;
  pendingAck: number;
  waitlist: number;
  utilization: number;
  isAtCapacity: boolean;
}> {
  return await withTransaction(pool, async (ctx) => {
    const jobResult = await ctx.query(
      'SELECT capacity FROM jobs WHERE id = $1',
      [jobId]
    );

    if (jobResult.rows.length === 0) {
      throw new AppError(
        `Job not found: ${jobId}`,
        404,
        'JOB_NOT_FOUND'
      );
    }

    const capacity = jobResult.rows[0].capacity;

    const statsResult = await ctx.query(
      `SELECT
        SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN status = 'PENDING_ACK' THEN 1 ELSE 0 END) as pending_ack,
        SUM(CASE WHEN status = 'WAITLISTED' THEN 1 ELSE 0 END) as waitlist
       FROM applications
       WHERE job_id = $1`,
      [jobId]
    );

    const row = statsResult.rows[0];
    const active = parseInt(row.active || 0, 10);
    const pendingAck = parseInt(row.pending_ack || 0, 10);
    const waitlist = parseInt(row.waitlist || 0, 10);
    const occupancy = active + pendingAck;
    const utilization = capacity > 0 ? occupancy / capacity : 0;

    return {
      capacity,
      active,
      pendingAck,
      waitlist,
      utilization: Math.round(utilization * 100) / 100,
      isAtCapacity: occupancy >= capacity,
    };
  });
}
