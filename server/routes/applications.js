const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../db/pool');
const { logTransition } = require('../services/logService');
const { promoteNext, getNextQueuePosition } = require('../services/promotionService');

const router = express.Router();

/**
 * POST /applications
 * Submit application: { name, email, job_id }
 * Handles capacity check and assigns status (ACTIVE or WAITLISTED)
 * Uses transaction with row-level locking for concurrency safety
 */
router.post('/', async (req, res) => {
  const { name, email, job_id } = req.body;

  if (!name || !email || !job_id) {
    return res.status(400).json({
      error: 'Missing fields: name, email, job_id',
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Find or create applicant (don't error on existing email)
    const applicantResult = await client.query(
      `INSERT INTO applicants (id, name, email) 
       VALUES (gen_random_uuid(), $1, $2)
       ON CONFLICT (email) 
       DO UPDATE SET name = EXCLUDED.name
       RETURNING *`,
      [name, email]
    );

    const applicantId = applicantResult.rows[0].id;

    // 2. Lock job row to prevent race conditions
    const jobResult = await client.query(
      'SELECT * FROM jobs WHERE id = $1 FOR UPDATE',
      [job_id]
    );

    if (jobResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Job not found' });
    }

    const job = jobResult.rows[0];

    // 3. Check if already applied to this job
    const existingResult = await client.query(
      `SELECT id, status FROM applications 
       WHERE job_id = $1 AND applicant_id = $2 
       AND status NOT IN ('REJECTED', 'HIRED')`,
      [job_id, applicantId]
    );

    if (existingResult.rows.length > 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({
        error: 'Already applied to this job',
      });
    }

    // 4. Determine status: ACTIVE if capacity available, else WAITLISTED
    const applicationId = uuidv4();
    let status = 'APPLIED';
    let queuePosition = null;
    let ackDeadline = null;

    if (job.active_count < job.capacity) {
      status = 'ACTIVE';
      ackDeadline = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
    } else {
      status = 'WAITLISTED';
      queuePosition = await getNextQueuePosition(client, job_id);
    }

    // 5. Insert application
    const insertQuery = `
      INSERT INTO applications (
        id, job_id, applicant_id, status, queue_position, ack_deadline, last_transition_at
      ) VALUES ($1, $2, $3, $4, $5, $6, NOW())
      RETURNING *
    `;

    const appResult = await client.query(insertQuery, [
      applicationId,
      job_id,
      applicantId,
      status,
      queuePosition,
      ackDeadline,
    ]);

    // 6. Update job active_count if ACTIVE
    if (status === 'ACTIVE') {
      await client.query(
        'UPDATE jobs SET active_count = active_count + 1 WHERE id = $1',
        [job_id]
      );
    }

    // 7. Log initial transition
    await logTransition(client, applicationId, 'APPLIED', status, {
      reason: 'new_application',
      triggered_by: 'applicationsRoute',
      capacity_check: {
        active_count: job.active_count,
        capacity: job.capacity,
      },
    });

    await client.query('COMMIT');
    res.status(201).json(appResult.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error submitting application:', err);
    res.status(500).json({ error: 'Failed to submit application', details: err.message });
  } finally {
    client.release();
  }
});

/**
 * GET /applications/:id
 * Retrieve application status and queue position
 */
router.get('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `SELECT a.*, ap.name, ap.email
       FROM applications a
       JOIN applicants ap ON a.applicant_id = ap.id
       WHERE a.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Application not found' });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching application:', err);
    res.status(500).json({ error: 'Failed to fetch application', details: err.message });
  }
});

/**
 * POST /applications/:id/ack
 * Acknowledge: resets ack_deadline for ACTIVE applicant
 */
router.post('/:id/ack', async (req, res) => {
  const { id } = req.params;
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const appResult = await client.query(
      'SELECT * FROM applications WHERE id = $1 FOR UPDATE',
      [id]
    );

    if (appResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Application not found' });
    }

    const app = appResult.rows[0];

    if (app.status !== 'ACTIVE') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Cannot acknowledge application with status: ${app.status}`,
      });
    }

    // Reset ack_deadline to 24 hours from now
    const newDeadline = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await client.query(
      `UPDATE applications 
       SET ack_deadline = $1, last_transition_at = NOW()
       WHERE id = $2`,
      [newDeadline, id]
    );

    // Log the acknowledgment
    await logTransition(client, id, 'ACTIVE', 'ACTIVE', {
      reason: 'acknowledged',
      triggered_by: 'applicationsRoute',
      new_ack_deadline: newDeadline.toISOString(),
    });

    await client.query('COMMIT');

    const updated = await pool.query(
      'SELECT * FROM applications WHERE id = $1',
      [id]
    );

    res.json(updated.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error acknowledging application:', err);
    res.status(500).json({ error: 'Failed to acknowledge application', details: err.message });
  } finally {
    client.release();
  }
});

/**
 * POST /applications/:id/exit
 * Exit application: { outcome: 'HIRED' | 'REJECTED' }
 * Automatically promotes next WAITLISTED applicant
 */
router.post('/:id/exit', async (req, res) => {
  const { id } = req.params;
  const { outcome } = req.body;

  if (!outcome || !['HIRED', 'REJECTED'].includes(outcome)) {
    return res.status(400).json({
      error: 'Invalid outcome: must be HIRED or REJECTED',
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const appResult = await client.query(
      'SELECT * FROM applications WHERE id = $1 FOR UPDATE',
      [id]
    );

    if (appResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Application not found' });
    }

    const app = appResult.rows[0];
    const previousStatus = app.status;

    if (previousStatus !== 'ACTIVE') {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Can only exit from ACTIVE status. Current status: ${previousStatus}`,
      });
    }

    // 1. Transition ACTIVE → outcome (HIRED/REJECTED)
    await client.query(
      `UPDATE applications 
       SET status = $1, ack_deadline = NULL, queue_position = NULL, last_transition_at = NOW()
       WHERE id = $2`,
      [outcome, id]
    );

    await logTransition(client, id, 'ACTIVE', outcome, {
      reason: 'manual_exit',
      triggered_by: 'applicationsRoute',
    });

    // 2. Decrement job's active_count
    await client.query(
      'UPDATE jobs SET active_count = active_count - 1 WHERE id = $1',
      [app.job_id]
    );

    // 3. Promote next WAITLISTED applicant (if any)
    const promotionSuccess = await promoteNext(client, app.job_id);

    await client.query('COMMIT');

    const updated = await pool.query(
      'SELECT * FROM applications WHERE id = $1',
      [id]
    );

    res.json({
      application: updated.rows[0],
      promoted: promotionSuccess,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error exiting application:', err);
    res.status(500).json({ error: 'Failed to exit application', details: err.message });
  } finally {
    client.release();
  }
});

module.exports = router;
