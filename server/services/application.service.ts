/**
 * ============================================================================
 * APPLICATION SERVICE (CORE BUSINESS LOGIC)
 * ============================================================================
 * 
 * CRITICAL:
 * 1. All functions are transactional (no cross-transaction calls)
 * 2. All must validate state transitions
 * 3. All must log to audit_logs
 * 4. Capacity checks use locking (FOR UPDATE)
 * 5. Queue positions always contiguous (reindexed by single query)
 */

import { Pool } from 'pg';
import { 
  withTransaction, 
  TransactionContext, 
  getJobForUpdate, 
  countActiveAndPendingAck, 
  checkDuplicateApplication, 
  getMaxQueuePosition, 
  reindexQueuePositions, 
  findOrCreateApplicant, 
  getApplication, 
  getApplicationForUpdate 
} from '../db/transactions';
import { validateTransition } from '../stateMachine';
import { ApplicationStatus } from '../stateMachine';
import { logTransition } from './auditLog.service';
import { promoteNext, cascadePromotion } from './promotion.service';

/**
 * ============================================================================
 * APPLY TO JOB (CRITICAL TRANSACTIONAL FLOW)
 * ============================================================================
 * 
 * STEPS:
 * 1. Find or create applicant by email
 * 2. Check for duplicate application (same job + applicant)
 * 3. Lock job for capacity check
 * 4. Count ACTIVE + PENDING_ACK
 * 5. If capacity available: insert as PENDING_ACK with ack_deadline
 * 6. Else: insert as WAITLISTED with queue_position
 * 7. Log transition to audit_logs
 * 8. Return application
 * 
 * ALL WITHIN ONE TRANSACTION
 */
export async function applyToJob(
  pool: Pool,
  email: string,
  name: string,
  jobId: string
): Promise<{
  applicationId: string;
  status: ApplicationStatus;
  queue_position: number | null;
  ack_deadline: string | null;
  message: string;
}> {
  return await withTransaction(pool, async (ctx) => {
    // STEP 1: Find or create applicant (Atomic UPSERT)
    const applicantId = await findOrCreateApplicant(ctx, email, name);

    // STEP 2: Check for duplicate application (same job + applicant)
    const isDuplicate = await checkDuplicateApplication(ctx, jobId, applicantId);
    if (isDuplicate) {
      throw new Error(
        `DUPLICATE_APPLICATION: Applicant already applied to this job. ` +
        `Email: ${email}, Job ID: ${jobId}`
      );
    }

    // STEP 3: Lock job for capacity control
    const job = await getJobForUpdate(ctx, jobId);

    // STEP 4: Count current active + pending ack
    const currentCount = await countActiveAndPendingAck(ctx, jobId);
    const availableCapacity = job.capacity - currentCount;

    let status: ApplicationStatus;
    let queuePosition: number | null = null;
    let ackDeadline: string | null = null;

    // STEP 5 & 6: Decide: PENDING_ACK or WAITLISTED
    if (availableCapacity > 0) {
      status = 'PENDING_ACK';
      const deadline = new Date();
      deadline.setMinutes(deadline.getMinutes() + 10);
      ackDeadline = deadline.toISOString();
    } else {
      status = 'WAITLISTED';
      const maxPos = await getMaxQueuePosition(ctx, jobId);
      queuePosition = maxPos + 1;
    }

    // STEP 7: Insert application
    const insertResult = await ctx.query(
      `INSERT INTO applications (job_id, applicant_id, status, queue_position, ack_deadline, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
       RETURNING id`,
      [jobId, applicantId, status, queuePosition, ackDeadline]
    );

    const applicationId = insertResult.rows[0].id;

    // STEP 8: Log the transition
    await logTransition(
      ctx,
      applicationId,
      null, 
      status,
      {
        email,
        jobId,
        applicantId,
        capacity: job.capacity,
        currentOccupancy: currentCount,
        availableCapacity,
        reason: availableCapacity > 0 ? 'immediate_slot_available' : 'added_to_waitlist',
      }
    );

    return {
      applicationId,
      status,
      queue_position: queuePosition,
      ack_deadline: ackDeadline,
      message:
        status === 'PENDING_ACK'
          ? `You are now pending acknowledgment. Please acknowledge within 10 minutes.`
          : `You have been added to waitlist at position ${queuePosition}. We will notify you when a slot opens.`,
    };
  });
}

/**
 * ============================================================================
 * ACKNOWLEDGE APPLICATION
 * ============================================================================
 * 
 * Transitions PENDING_ACK → ACTIVE
 * Only valid if:
 * - Current status is PENDING_ACK
 * - ack_deadline has not passed
 * - Applicant has not withdrawn
 */
export async function acknowledgeApplication(
  pool: Pool,
  applicationId: string
): Promise<{
  applicationId: string;
  status: ApplicationStatus;
  message: string;
}> {
  return await withTransaction(pool, async (ctx) => {
    // STEP 1: Lock application for update (Idempotency)
    const app = await getApplicationForUpdate(ctx, applicationId);

    // STEP 2: Idempotency check 
    if (app.status === 'ACTIVE') {
      return {
        applicationId,
        status: 'ACTIVE',
        message: 'Application already acknowledged.',
      };
    }

    // STEP 3: Validate state transition
    validateTransition(app.status as ApplicationStatus, 'ACTIVE');

    // STEP 4: Check deadline
    if (app.ack_deadline && new Date(app.ack_deadline) < new Date()) {
      throw new Error(`ACK_DEADLINE_EXPIRED: Acknowledgment window has closed for application ${applicationId}`);
    }

    // STEP 5: Update status
    await ctx.query(
      `UPDATE applications SET status = $1, updated_at = NOW() WHERE id = $2`,
      ['ACTIVE', applicationId]
    );

    // STEP 6: Log transition
    await logTransition(ctx, applicationId, app.status, 'ACTIVE', {
      reason: 'applicant_acknowledged',
    });

    return {
      applicationId,
      status: 'ACTIVE',
      message: 'You have been successfully moved to active status.',
    };
  });
}

/**
 * ============================================================================
 * WITHDRAW APPLICATION
 * ============================================================================
 * 
 * Applicant can withdraw from PENDING_ACK or ACTIVE
 * Triggers promotion cascade if withdrew from ACTIVE (immediately fills freed slot)
 */
export async function withdrawApplication(
  pool: Pool,
  applicationId: string,
  reason: string = 'applicant_request'
): Promise<{
  applicationId: string;
  status: ApplicationStatus;
  message: string;
  cascadePromoted?: number | string;
}> {
  // STEP 1: Withdraw inside transaction
  const result = await withTransaction(pool, async (ctx) => {
    // LOCK ORDER: 1. Job, 2. Application
    // We need job ID first to lock job
    const initialApp = await getApplication(ctx, applicationId);
    const jobId = initialApp.job_id;

    // 1. Lock Job (Ensures capacity checks in promotion are stable)
    await getJobForUpdate(ctx, jobId);

    // 2. Lock Application (FOR UPDATE)
    const app = await getApplicationForUpdate(ctx, applicationId);

    // Idempotency check
    if (app.status === 'INACTIVE') {
      return { applicationId, status: 'INACTIVE' as ApplicationStatus, jobId, wasOccupyingSlot: false };
    }

    // Validate state transition
    validateTransition(app.status as ApplicationStatus, 'INACTIVE');

    const wasOccupyingSlot = app.status === 'ACTIVE' || app.status === 'PENDING_ACK';
    const wasWaitlisted = app.status === 'WAITLISTED';

    // 3. Update status
    await ctx.query(
      `UPDATE applications SET status = $1, queue_position = NULL, ack_deadline = NULL, updated_at = NOW() WHERE id = $2`,
      ['INACTIVE', applicationId]
    );

    // 4. Log transition
    await logTransition(ctx, applicationId, app.status as ApplicationStatus, 'INACTIVE', {
      reason,
      wasOccupyingSlot,
    });

    // 5. Repair Queue if withdrawn from waitlist
    if (wasWaitlisted) {
      await reindexQueuePositions(ctx, jobId);
    }

    // 6. Immediate Promotion (Single)
    let promotedId: number | null = null;
    if (wasOccupyingSlot) {
      const promotion = await promoteNext(ctx, jobId);
      if (promotion) promotedId = promotion.applicationId;
    }

    return {
      applicationId,
      status: 'INACTIVE' as ApplicationStatus,
      jobId,
      wasOccupyingSlot,
      promotedId,
    };
  });

  // STEP 2: After transaction commits, trigger optional full cascade
  let totalPromoted = result.promotedId ? 1 : 0;
  if (result.wasOccupyingSlot) {
    try {
      // Start a fresh transaction for the remaining cascade to keep locks short
      const cascadeResult = await withTransaction(pool, async (ctx) => {
        return await cascadePromotion(ctx, result.jobId);
      });
      totalPromoted += (cascadeResult.totalPromoted || 0);
    } catch (err) {
      console.warn(`Full cascade promotion after withdrawal failed: ${err}`);
    }
  }

  return {
    applicationId: result.applicationId,
    status: result.status,
    message: 'Your application has been withdrawn.',
    cascadePromoted: totalPromoted,
  };
}

/**
 * ============================================================================
 * EXIT APPLICATION (HIRED/REJECTED)
 * ============================================================================
 * 
 * Transitions ACTIVE → HIRED or REJECTED
 * Triggers cascade promotion to immediately fill freed slot
 */
export async function exitApplication(
  pool: Pool,
  applicationId: string,
  exitStatus: 'HIRED' | 'REJECTED'
): Promise<{
  applicationId: string;
  status: ApplicationStatus;
  message: string;
  cascadePromoted?: number;
}> {
  if (exitStatus !== 'HIRED' && exitStatus !== 'REJECTED') {
    throw new Error(`INVALID_EXIT_STATUS: Must be HIRED or REJECTED, got ${exitStatus}`);
  }

  // STEP 1: Exit inside transaction
  const result = await withTransaction(pool, async (ctx) => {
    // LOCK ORDER: 1. Job, 2. Application
    const initialApp = await getApplication(ctx, applicationId);
    const jobId = initialApp.job_id;

    // 1. Lock Job
    await getJobForUpdate(ctx, jobId);

    // 2. Lock Application
    const app = await getApplicationForUpdate(ctx, applicationId);

    // Idempotency check
    if (app.status === exitStatus) {
      return { applicationId, status: exitStatus, jobId, promotedId: null };
    }

    // Can only exit from ACTIVE
    if (app.status !== 'ACTIVE') {
      throw new Error(
        `INVALID_EXIT: Cannot transition to ${exitStatus} from ${app.status}. ` +
        `Can only exit from ACTIVE.`
      );
    }

    // Validate state transition
    validateTransition(app.status as ApplicationStatus, exitStatus);

    // 3. Update status
    await ctx.query(
      `UPDATE applications SET status = $1, queue_position = NULL, ack_deadline = NULL, updated_at = NOW() WHERE id = $2`,
      [exitStatus, applicationId]
    );

    // 4. Log transition
    await logTransition(ctx, applicationId, app.status as ApplicationStatus, exitStatus, {
      reason: `recruiter_${exitStatus.toLowerCase()}`,
    });

    // 5. Immediate Promotion (Single)
    let promotedId: number | null = null;
    const promotion = await promoteNext(ctx, jobId);
    if (promotion) promotedId = promotion.applicationId;

    return {
      applicationId,
      status: exitStatus,
      jobId,
      promotedId,
    };
  });

  // STEP 2: After transaction commits, trigger optional full cascade
  let totalPromoted = result.promotedId ? 1 : 0;
  try {
    const cascadeResult = await withTransaction(pool, async (ctx) => {
      return await cascadePromotion(ctx, result.jobId);
    });
    totalPromoted += (cascadeResult.totalPromoted || 0);
  } catch (err) {
    console.warn(`Full cascade promotion after exit failed: ${err}`);
  }

  return {
    applicationId: result.applicationId,
    status: result.status as ApplicationStatus,
    message: `Application marked as ${exitStatus}.`,
    cascadePromoted: totalPromoted,
  };
}

/**
 * Get application details (with full audit trail)
 */
export async function getApplicationDetails(
  pool: Pool,
  applicationId: string
): Promise<any> {
  return await withTransaction(pool, async (ctx) => {
    const app = await getApplication(ctx, applicationId);

    // Get applicant info
    const applicantResult = await ctx.query(
      'SELECT id, email, name FROM applicants WHERE id = $1',
      [app.applicant_id]
    );
    const applicant = applicantResult.rows[0];

    // Get job info
    const jobResult = await ctx.query(
      'SELECT id, title, capacity FROM jobs WHERE id = $1',
      [app.job_id]
    );
    const job = jobResult.rows[0];

    return {
      id: app.id,
      applicant: {
        id: applicant.id,
        email: applicant.email,
        name: applicant.name,
      },
      job: {
        id: job.id,
        title: job.title,
        capacity: job.capacity,
      },
      status: app.status,
      queue_position: app.queue_position,
      ack_deadline: app.ack_deadline,
      penalty_count: app.penalty_count,
      created_at: app.created_at,
      updated_at: app.updated_at,
    };
  });
}
