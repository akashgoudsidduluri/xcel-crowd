import { TransactionContext } from '../db/transactions';
import { AppError } from '../errors';

/**
 * METRICS SERVICE
 * 
 * Provides structured business intelligence and system health observations.
 */

export interface JobMetrics {
  jobId: string;
  timestamp: string;
  
  // Real-time state
  occupancy: number;
  capacity: number;
  utilization: number;
  waitlistSize: number;
  
  // Historical / Turnover metrics
  hiredCount: number;
  rejectedCount: number;
  turnoverCount: number; // Total HIRED + REJECTED
  decayFrequency: number; // Number of expirations
  avgWaitTimeSeconds: number;
  
  // Insight Metrics
  conversionRate: number;   // HIRED / TOTAL
  waitlistPressure: number; // WAITLISTED / CAPACITY
  decayRate: number;        // DECAYED / TOTAL

  // Health markers
  isAtCapacity: boolean;
  isStalled: boolean; // True if waitlisted but no movement for X hours
}

/**
 * Aggregate metrics for a specific job
 */
export async function getJobMetrics(
  ctx: TransactionContext,
  jobId: string
): Promise<JobMetrics> {
  // 1. Get Job & Capacity
  const jobResult = await ctx.query(
    'SELECT capacity, created_at FROM jobs WHERE id = $1',
    [jobId]
  );
  
  if (jobResult.rows.length === 0) {
    throw new AppError(
      `Job not found: ${jobId}`,
      404,
      'JOB_NOT_FOUND'
    );
  }
  
  const job = jobResult.rows[0];
  const capacity = job.capacity;

  // 2. Get Application Counts (State Snapshot)
  const statsResult = await ctx.query(
    `SELECT
      SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) as active,
      SUM(CASE WHEN status = 'PENDING_ACK' THEN 1 ELSE 0 END) as pending_ack,
      SUM(CASE WHEN status = 'WAITLISTED' THEN 1 ELSE 0 END) as waitlist,
      SUM(CASE WHEN status = 'HIRED' THEN 1 ELSE 0 END) as hired,
      SUM(CASE WHEN status = 'REJECTED' THEN 1 ELSE 0 END) as rejected
     FROM applications
     WHERE job_id = $1`,
    [jobId]
  );
  
  const stats = statsResult.rows[0];
  const activeCount = parseInt(stats.active || 0, 10);
  const pendingAckCount = parseInt(stats.pending_ack || 0, 10);
  const waitlistSize = parseInt(stats.waitlist || 0, 10);
  const hiredCount = parseInt(stats.hired || 0, 10);
  const rejectedCount = parseInt(stats.rejected || 0, 10);
  const outcomesCount = hiredCount + rejectedCount;
  const totalApplications = activeCount + pendingAckCount + waitlistSize + outcomesCount;
  
  const occupancy = activeCount + pendingAckCount;
  
  // 3. Get Decay Frequency (Historical Status Changes)
  const auditResult = await ctx.query(
    `SELECT COUNT(*) as decay_count
     FROM audit_logs
     WHERE application_id IN (SELECT id FROM applications WHERE job_id = $1)
       AND from_status = 'PENDING_ACK'
       AND to_status = 'WAITLISTED'`,
    [jobId]
  );
  
  // 4. Calculate Average Wait Time (Waitlisted -> Pending Ack)
  const waitTimeResult = await ctx.query(
    `SELECT AVG(EXTRACT(EPOCH FROM (l.created_at - a.created_at))) as avg_wait
     FROM audit_logs l
     JOIN applications a ON l.application_id = a.id
     WHERE a.job_id = $1
       AND l.from_status = 'WAITLISTED'
       AND l.to_status = 'PENDING_ACK'`,
    [jobId]
  );

  // 5. Check for recent promotion activity (last 60 seconds)
  const recentPromotionsResult = await ctx.query(
    `SELECT COUNT(*) as promotion_count
     FROM audit_logs
     WHERE job_id = $1
       AND from_status = 'WAITLISTED'
       AND to_status = 'PENDING_ACK'
       AND created_at > NOW() - INTERVAL '60 seconds'`,
    [jobId]
  );
  const recentPromotions = parseInt(recentPromotionsResult.rows[0].promotion_count || 0, 10);

  return {
    jobId,
    timestamp: new Date().toISOString(),
    occupancy,
    capacity,
    utilization: capacity > 0 ? Math.round((occupancy / capacity) * 100) / 100 : 0,
    waitlistSize,
    hiredCount,
    rejectedCount,
    turnoverCount: outcomesCount,
    decayFrequency: parseInt(auditResult.rows[0].decay_count || 0, 10),
    avgWaitTimeSeconds: Number(parseFloat(waitTimeResult.rows[0].avg_wait || 0).toFixed(2)),
    
    // Derived Insights
    conversionRate: totalApplications > 0 ? Math.round((hiredCount / totalApplications) * 100) / 100 : 0,
    waitlistPressure: capacity > 0 ? Math.round((waitlistSize / capacity) * 100) / 100 : 0,
    decayRate: totalApplications > 0 ? Math.round((parseInt(auditResult.rows[0].decay_count || 0, 10) / totalApplications) * 100) / 100 : 0,

    isAtCapacity: occupancy >= capacity,
    isStalled: waitlistSize > 0 && occupancy < capacity && recentPromotions === 0
  };
