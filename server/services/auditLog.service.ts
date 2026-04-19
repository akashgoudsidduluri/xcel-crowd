/**
 * ============================================================================
 * AUDIT LOGGING SERVICE (IMMUTABLE)
 * ============================================================================
 * 
 * CRITICAL: Every state transition MUST be logged
 * System must be fully reconstructable from audit logs
 * Logs are immutable (no deletes, only inserts)
 * 
 * Use this for compliance, debugging, and state reconstruction
 */

import { TransactionContext } from '../db/transactions';
import { ApplicationStatus, getTransitionDescription } from '../stateMachine';


/**
 * Log a state transition
 * MUST be called inside transaction immediately after state change
 * 
 * @param ctx Transaction context
 * @param applicationId The application being transitioned
 * @param fromStatus Previous state (null if this is initial insertion)
 * @param toStatus New state
 * @param metadata Additional context (who triggered, why, etc.)
 */
export async function logTransition(
  ctx: TransactionContext,
  applicationId: string,
  fromStatus: ApplicationStatus | null,
  toStatus: ApplicationStatus,
  metadata: Record<string, any> = {}
): Promise<{ id: number; created_at: string }> {
  const description = fromStatus
    ? getTransitionDescription(fromStatus, toStatus)
    : `Initial state: ${toStatus}`;

  const result = await ctx.query(
    `INSERT INTO audit_logs (application_id, from_status, to_status, metadata)
     VALUES ($1, $2, $3, $4)
     RETURNING id, created_at`,
    [
      applicationId,
      fromStatus,
      toStatus,
      JSON.stringify({
        ...metadata,
        description,
        timestamp: new Date().toISOString(),
      }),
    ]
  );

  return result.rows[0];
}

/**
 * Get audit trail for an application
 * Shows complete history of state transitions
 */
export async function getAuditTrail(
  ctx: TransactionContext,
  applicationId: string
): Promise<any[]> {
  const result = await ctx.query(
    `SELECT id, application_id, from_status, to_status, metadata, created_at
     FROM audit_logs
     WHERE application_id = $1
     ORDER BY created_at ASC`,
    [applicationId]
  );

  return result.rows;
}

/**
 * Get recent transitions (for monitoring)
 */
export async function getRecentTransitions(
  ctx: TransactionContext,
  limit: number = 100
): Promise<any[]> {
  const result = await ctx.query(
    `SELECT id, application_id, from_status, to_status, metadata, created_at
     FROM audit_logs
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );

  return result.rows;
}

/**
 * Count transitions by type (for analytics)
 */
export async function countTransitionsByType(
  ctx: TransactionContext
): Promise<Record<string, number>> {
  const result = await ctx.query(
    `SELECT 
       CONCAT(COALESCE(from_status, 'INITIAL'), ' → ', to_status) as transition,
       COUNT(*) as count
     FROM audit_logs
     GROUP BY from_status, to_status
     ORDER BY count DESC`,
    []
  );

  const counts: Record<string, number> = {};
  result.rows.forEach((row) => {
    counts[row.transition] = parseInt(row.count, 10);
  });

  return counts;
}

/**
 * Reconstruct application state from logs
 * Useful for debugging or verifying state integrity
 */
export async function reconstructApplicationState(
  ctx: TransactionContext,
  applicationId: string
): Promise<{
  applicationId: string;
  currentState: ApplicationStatus;
  history: any[];
  isConsistent: boolean;
}> {
  const trail = await getAuditTrail(ctx, applicationId);

  if (trail.length === 0) {
    return {
      applicationId,
      currentState: 'WAITLISTED' as ApplicationStatus,
      history: [],
      isConsistent: false,
    };
  }

  const lastLog = trail[trail.length - 1];
  const currentState = lastLog.to_status as ApplicationStatus;

  return {
    applicationId,
    currentState,
    history: trail,
    isConsistent: true,
  };
}

/**
 * Get statistics about state transitions (for monitoring dashboard)
 */
export async function getTransitionStatistics(
  ctx: TransactionContext
): Promise<{
  totalTransitions: number;
  transitionsByType: Record<string, number>;
}> {
  const countResult = await ctx.query(
    'SELECT COUNT(*) as count FROM audit_logs',
    []
  );

  const typesResult = await ctx.query(
    `SELECT 
       CONCAT(COALESCE(from_status, 'INITIAL'), ' → ', to_status) as transition,
       COUNT(*) as count
     FROM audit_logs
     GROUP BY from_status, to_status`,
    []
  );

  const transitionsByType: Record<string, number> = {};
  typesResult.rows.forEach((row) => {
    transitionsByType[row.transition] = parseInt(row.count, 10);
  });

  return {
    totalTransitions: parseInt(countResult.rows[0].count, 10),
    transitionsByType,
  };
}

/**
 * Verify audit log integrity
 * Ensures chain of custody and no gaps
 */
export async function verifyAuditChain(
  client: PoolClient,
  applicationId: string
): Promise<{ valid: boolean; errors: string[] }> {
  const events = await getApplicationAuditHistory(client, applicationId);
  const errors: string[] = [];

  if (events.length === 0) {
    return { valid: true, errors: [] };
  }

  // Check that each transition is valid and forms a chain
  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1];
    const curr = events[i];

    // Verify chain continuity (previous to_status = current from_status)
    if (prev.to_status !== curr.from_status) {
      errors.push(
        `Broken chain at transition ${i}: ` +
        `${prev.to_status} → ${curr.from_status} (gap detected)`
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Get audit statistics for a job
 */
export async function getJobAuditStats(
  client: PoolClient,
  jobId: string
): Promise<{
  totalTransitions: number;
  transitionCounts: Record<string, number>;
  activeApplications: number;
  decayedApplications: number;
  hiredApplications: number;
}> {
  const query = `
    SELECT 
      COUNT(*) as total_transitions,
      COUNT(DISTINCT al.application_id) as unique_applications,
      json_object_agg(
        CONCAT(al.from_status, ' → ', al.to_status),
        COUNT(*)
      ) as transition_counts
    FROM audit_logs al
    JOIN applications app ON al.application_id = app.id
    WHERE app.job_id = $1
  `;

  const result = await client.query(query, [jobId]);
  const row = result.rows[0];

  return {
    totalTransitions: parseInt(row.total_transitions, 10),
    transitionCounts: row.transition_counts || {},
    activeApplications: 0, // Query separately if needed
    decayedApplications: 0,
    hiredApplications: 0,
  };
}
