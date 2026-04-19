/**
 * ============================================================================
 * JOBS ROUTES
 * ============================================================================
 * 
 * HTTP API for job management
 */

import { Router, Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { withTransaction } from '../db/transactions';

export function createJobRoutes(pool: Pool): Router {
  const router = Router();

  /**
   * POST /jobs
   * Create a new job
   * 
   * BODY: { title, capacity }
   */
  router.post('/jobs', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { title, capacity, created_by } = req.body;

      if (!title || !capacity || capacity < 1) {
        return res.status(400).json({
          error: 'Missing or invalid fields: title (string), capacity (positive integer)',
        });
      }

      const result = await withTransaction(pool, async (ctx) => {
        const jobResult = await ctx.query(
          'INSERT INTO jobs (title, capacity, created_by) VALUES ($1, $2, $3) RETURNING id, title, capacity, created_by, created_at',
          [title, parseInt(capacity, 10), created_by || null]
        );
        return jobResult.rows[0];
      });

      return res.status(201).json(result);
    } catch (err) {
      return next(err);
    }
  });

  /**
   * GET /jobs/:id
   * Get job details with queue statistics
   */
  router.get(
    '/jobs/:id',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const jobId = req.params.id as string;

        if (!jobId) {
          return res.status(400).json({ error: 'Invalid job ID' });
        }

        const result = await withTransaction(pool, async (ctx) => {
          // Get job
          const jobResult = await ctx.query(
            'SELECT id, title, capacity, created_at FROM jobs WHERE id = $1',
            [jobId]
          );

          if (jobResult.rows.length === 0) {
            throw new Error(`Job not found: ${jobId}`);
          }

          const job = jobResult.rows[0];

          // Get application counts
          const statsResult = await ctx.query(
            `SELECT
              SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) as active,
              SUM(CASE WHEN status = 'PENDING_ACK' THEN 1 ELSE 0 END) as pending_ack,
              SUM(CASE WHEN status = 'WAITLISTED' THEN 1 ELSE 0 END) as waitlist,
              SUM(CASE WHEN status = 'HIRED' THEN 1 ELSE 0 END) as hired,
              SUM(CASE WHEN status = 'REJECTED' THEN 1 ELSE 0 END) as rejected,
              SUM(CASE WHEN status = 'INACTIVE' THEN 1 ELSE 0 END) as inactive
             FROM applications
             WHERE job_id = $1`,
            [jobId]
          );

          const stats = statsResult.rows[0];
          const occupancy = parseInt(stats.active || 0, 10) + parseInt(stats.pending_ack || 0, 10);

          return {
            job,
            statistics: {
              capacity: job.capacity,
              occupancy,
              utilization: job.capacity > 0 ? occupancy / job.capacity : 0,
              isAtCapacity: occupancy >= job.capacity,
              active: parseInt(stats.active || 0, 10),
              pending_ack: parseInt(stats.pending_ack || 0, 10),
              waitlist: parseInt(stats.waitlist || 0, 10),
              hired: parseInt(stats.hired || 0, 10),
              rejected: parseInt(stats.rejected || 0, 10),
              inactive: parseInt(stats.inactive || 0, 10),
            },
          };
        });

        return res.status(200).json(result);
      } catch (err) {
        const error = err as Error;

        if (error.message.includes('Job not found')) {
          return res.status(404).json({ error: error.message });
        }

        return next(err);
      }
    }
  );

  /**
   * GET /jobs
   * List all jobs with statistics
   */
  router.get('/jobs', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const results = await withTransaction(pool, async (ctx) => {
        const jobsResult = await ctx.query(
          'SELECT id, title, capacity, created_at FROM jobs ORDER BY created_at DESC'
        );

        const jobs = await Promise.all(
          jobsResult.rows.map(async (job) => {
            const statsResult = await ctx.query(
              `SELECT
                SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) as active,
                SUM(CASE WHEN status = 'PENDING_ACK' THEN 1 ELSE 0 END) as pending_ack,
                SUM(CASE WHEN status = 'WAITLISTED' THEN 1 ELSE 0 END) as waitlist
               FROM applications
               WHERE job_id = $1`,
              [job.id]
            );

            const stats = statsResult.rows[0];
            const occupancy =
              parseInt(stats.active || 0, 10) +
              parseInt(stats.pending_ack || 0, 10);

            return {
              ...job,
              occupancy,
              utilization: job.capacity > 0 ? occupancy / job.capacity : 0,
              isAtCapacity: occupancy >= job.capacity,
            };
          })
        );

        return jobs;
      });

      return res.status(200).json(results);
    } catch (err) {
      return next(err);
    }
  });

  return router;
}
