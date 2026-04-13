const { pool } = require('../db/pool');
const { logTransition } = require('./logService');
const { promoteNext, getNextQueuePosition } = require('./promotionService');

let workerInterval = null;

/**
 * Find and process all expired ACTIVE applications
 * Each decayed application is re-queued at the end and promotion is triggered
 */
async function processDecayedApplications() {
  const client = await pool.connect();

  try {
    // Query all ACTIVE applications with expired ack_deadline
    const expiredResult = await client.query(
      `SELECT id, job_id FROM applications 
       WHERE status = 'ACTIVE' AND ack_deadline < NOW()
       ORDER BY created_at ASC`
    );

    console.log(`[DECAY WORKER] Found ${expiredResult.rows.length} expired applications`);

    for (const { id: applicationId, job_id: jobId } of expiredResult.rows) {
      await client.query('BEGIN');

      try {
        // 1. Transition ACTIVE → DECAYED
        await client.query(
          `UPDATE applications 
           SET status = 'DECAYED', last_transition_at = NOW()
           WHERE id = $1`,
          [applicationId]
        );

        await logTransition(client, applicationId, 'ACTIVE', 'DECAYED', {
          reason: 'ack_deadline_expired',
          triggered_by: 'decayWorker',
        });

        // 2. Lock job row to prevent race conditions
        await client.query('SELECT * FROM jobs WHERE id = $1 FOR UPDATE', [jobId]);

        // 3. Decrement active_count (slot is now open)
        await client.query(
          'UPDATE jobs SET active_count = active_count - 1 WHERE id = $1',
          [jobId]
        );

        // 4. Get next queue position for end of WAITLISTED queue
        const nextPosition = await getNextQueuePosition(client, jobId);

        // 5. Transition DECAYED → WAITLISTED
        await client.query(
          `UPDATE applications 
           SET status = 'WAITLISTED', queue_position = $1, ack_deadline = NULL, last_transition_at = NOW()
           WHERE id = $2`,
          [nextPosition, applicationId]
        );

        await logTransition(client, applicationId, 'DECAYED', 'WAITLISTED', {
          reason: 'requeued_after_decay',
          triggered_by: 'decayWorker',
          penalty: 'queued_at_end',
        });

        // 6. Promote next applicant to fill the vacated slot
        await promoteNext(client, jobId);

        await client.query('COMMIT');
        console.log(`[DECAY WORKER] Processed application ${applicationId}`);
      } catch (innerErr) {
        await client.query('ROLLBACK');
        console.error(`[DECAY WORKER] Error processing application ${applicationId}:`, innerErr.message);
      }
    }
  } catch (err) {
    console.error('[DECAY WORKER] Fatal error:', err.message);
  } finally {
    client.release();
  }
}

/**
 * Start the background decay worker
 * Runs every 30-60 seconds (configurable)
 */
function startDecayWorker(intervalMs = 45 * 1000) {
  if (workerInterval) {
    console.warn('[DECAY WORKER] Worker already running');
    return;
  }

  console.log(`[DECAY WORKER] Started with interval: ${intervalMs}ms`);

  workerInterval = setInterval(async () => {
    try {
      await processDecayedApplications();
    } catch (err) {
      console.error('[DECAY WORKER] Unexpected error:', err.message);
    }
  }, intervalMs);
}

/**
 * Stop the background decay worker
 */
function stopDecayWorker() {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
    console.log('[DECAY WORKER] Stopped');
  }
}

module.exports = {
  startDecayWorker,
  stopDecayWorker,
  processDecayedApplications,
};
