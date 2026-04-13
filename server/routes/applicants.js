const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../db/pool');

const router = express.Router();

/**
 * POST /applicants
 * Create a new applicant
 */
router.post('/', async (req, res) => {
  const { name, email } = req.body;

  if (!name || !email) {
    return res.status(400).json({
      error: 'Missing fields: name (string), email (string)',
    });
  }

  const applicantId = uuidv4();
  const query = `
    INSERT INTO applicants (id, name, email)
    VALUES ($1, $2, $3)
    RETURNING *
  `;

  try {
    const result = await pool.query(query, [applicantId, name, email]);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Email already exists' });
    }
    console.error('Error creating applicant:', err);
    res.status(500).json({ error: 'Failed to create applicant', details: err.message });
  }
});

/**
 * GET /applicants/:id
 * Retrieve applicant details
 */
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  const query = 'SELECT * FROM applicants WHERE id = $1';

  try {
    const result = await pool.query(query, [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Applicant not found' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Error fetching applicant:', err);
    res.status(500).json({ error: 'Failed to fetch applicant', details: err.message });
  }
});

/**
 * GET /applicants
 * List all applicants
 */
router.get('/', async (req, res) => {
  const query = `
    SELECT id, name, email, created_at
    FROM applicants
    ORDER BY created_at DESC
  `;

  try {
    const result = await pool.query(query);
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching applicants:', err);
    res.status(500).json({ error: 'Failed to fetch applicants', details: err.message });
  }
});

module.exports = router;
