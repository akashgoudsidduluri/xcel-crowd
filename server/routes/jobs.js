const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../db/pool');
const { logTransition } = require('../services/logService');

const router = express.Router();

/**
 * POST /jobs
 * Create a new job with given title and capacity
 */
router.post('/', async (req, res) => {
  const { title, capacity } = req.body;

  if (!title || !capacity || capacity < 1) {
    return res.status(400).json({
      error: 'Missing or invalid fields: title (string), capacity (int > 0)',
    });
  }

  const jobId = uuidv4();
  const query = `
    INSERT INTO jobs (id, title, capacity, active_count)
    VALUES ($1, $2, $3, 0)
    RETURNING *
  `;

  try {
    const result = await pool.query(query, [jobId, title, capacity]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating job:', err);
    res.status(500).json({ error: 'Failed to create job', details: err.message });
  }
});

/**
 * GET /jobs/:id
 * Retrieve job details
 */
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  const query = 'SELECT * FROM jobs WHERE id = $1';

  try {
    const result = await pool.query(query, [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching job:', err);
    res.status(500).json({ error: 'Failed to fetch job', details: err.message });
  }
});

/**
 * GET /jobs/:id/pipeline
 * Retrieve full pipeline snapshot for a job
 * Returns all applicants segmented by status with queue positions
 */
router.get('/:id/pipeline', async (req, res) => {
  const { id } = req.params;

  try {
    const jobResult = await pool.query(
      'SELECT * FROM jobs WHERE id = $1',
      [id]
    );

    if (jobResult.rows.length === 0) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const job = jobResult.rows[0];

    const applicationsResult = await pool.query(
      `SELECT 
        a.id,
        a.job_id,
        a.applicant_id,
        ap.name,
        ap.email,
        a.status,
        a.queue_position,
        a.ack_deadline,
        a.last_transition_at,
        a.created_at
       FROM applications a
       JOIN applicants ap ON a.applicant_id = ap.id
       WHERE a.job_id = $1
       ORDER BY CASE 
         WHEN a.status = 'ACTIVE' THEN 0
         WHEN a.status = 'WAITLISTED' THEN 1
         WHEN a.status = 'HIRED' THEN 2
         WHEN a.status = 'REJECTED' THEN 3
         WHEN a.status = 'DECAYED' THEN 4
         ELSE 5
       END, a.queue_position ASC, a.created_at ASC`,
      [id]
    );

    const pipeline = {
      job,
      applicants: applicationsResult.rows,
      summary: {
        total: applicationsResult.rows.length,
        active: applicationsResult.rows.filter(a => a.status === 'ACTIVE').length,
        waitlisted: applicationsResult.rows.filter(a => a.status === 'WAITLISTED').length,
        hired: applicationsResult.rows.filter(a => a.status === 'HIRED').length,
        rejected: applicationsResult.rows.filter(a => a.status === 'REJECTED').length,
      },
    };

    res.json(pipeline);
  } catch (err) {
    console.error('Error fetching pipeline:', err);
    res.status(500).json({ error: 'Failed to fetch pipeline', details: err.message });
  }
});

/**
 * GET /jobs
 * List all jobs
 */
router.get('/', async (req, res) => {
  const query = `
    SELECT 
      id,
      title,
      capacity,
      active_count,
      created_at
    FROM jobs
    ORDER BY created_at DESC
  `;

  try {
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching jobs:', err);
    res.status(500).json({ error: 'Failed to fetch jobs', details: err.message });
  }
});

module.exports = router;
