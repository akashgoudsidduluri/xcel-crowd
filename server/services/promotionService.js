const { logTransition } = require('./logService');

/**
 * Promote the next WAITLISTED applicant to ACTIVE
 * MUST be called within a transaction with proper error handling
 * Returns true if a promotion occurred, false if no WAITLISTED applicants remain
 */
async function promoteNext(client, jobId) {
  // 1. Decrement active_count
  await client.query(
    'UPDATE jobs SET active_count = active_count - 1 WHERE id = $1',
    [jobId]
  );

  // 2. Find next WAITLISTED applicant (lowest queue_position)
  const nextApplicantResult = await client.query(
    `SELECT id, applicant_id FROM applications 
     WHERE job_id = $1 AND status = 'WAITLISTED' 
     ORDER BY queue_position ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
    [jobId]
  );

  if (nextApplicantResult.rows.length === 0) {
    // No one to promote, return false
    return false;
  }

  const { id: applicationId } = nextApplicantResult.rows[0];

  // 3. Transition to ACTIVE and set ack_deadline
  const ackDeadline = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours from now
  await client.query(
    `UPDATE applications 
     SET status = 'ACTIVE', queue_position = NULL, ack_deadline = $1, last_transition_at = NOW()
     WHERE id = $2`,
    [ackDeadline, applicationId]
  );

  // 4. Log the transition
  await logTransition(client, applicationId, 'WAITLISTED', 'ACTIVE', {
    reason: 'promoted_from_waitlist',
    triggered_by: 'promotionService',
  });

  // 5. Increment active_count
  await client.query(
    'UPDATE jobs SET active_count = active_count + 1 WHERE id = $1',
    [jobId]
  );

  // 6. Reindex remaining WAITLISTED queue positions
  await reindexQueue(client, jobId);

  return true;
}

/**
 * Reindex queue positions for all WAITLISTED applicants
 * Assigns contiguous integers starting from 0
 */
async function reindexQueue(client, jobId) {
  const query = `
    WITH ranked AS (
      SELECT id, ROW_NUMBER() OVER (ORDER BY queue_position ASC) - 1 as new_position
      FROM applications
      WHERE job_id = $1 AND status = 'WAITLISTED'
    )
    UPDATE applications a
    SET queue_position = r.new_position
    FROM ranked r
    WHERE a.id = r.id
  `;

  await client.query(query, [jobId]);
}

/**
 * Get the next available queue position for a new WAITLISTED applicant
 */
async function getNextQueuePosition(client, jobId) {
  const result = await client.query(
    `SELECT COALESCE(MAX(queue_position), -1) + 1 as next_position
     FROM applications
     WHERE job_id = $1 AND status = 'WAITLISTED'`,
    [jobId]
  );

  return result.rows[0].next_position;
}

module.exports = {
  promoteNext,
  reindexQueue,
  getNextQueuePosition,
};
