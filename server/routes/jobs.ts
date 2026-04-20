/**
 * ============================================================================
 * JOBS ROUTES
 * ============================================================================
 * 
 * HTTP API for job management
 */

import { Router, Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { z } from 'zod';
import { withTransaction } from '../db/transactions';
import { generalLimiter } from '../middlewares/rateLimiter';
import { getJobMetrics } from '../services/metrics.service';

export function createJobRoutes(pool: Pool): Router {
  const router = Router();

  // Zod schema
  const createJobSchema = z.object({
    title: z.string().min(1),
    capacity: z.number().int().positive(),
    created_by: z.string().optional(),
  });

  /**
   * POST /jobs
   * Create a new job
   * 
   * BODY: { title, capacity }
   */
  router.post('/jobs', generalLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = createJobSchema.safeParse(req.body);

      if (!parsed.success) {
        return res.status(400).json({
          error: 'INVALID_INPUT',
          details: parsed.error.issues,
        });
      }

      const { title, capacity, created_by } = parsed.data;

      const result = await withTransaction(pool, async (ctx) => {
        const jobResult = await ctx.query(
          'INSERT INTO jobs (title, capacity, created_by) VALUES ($1, $2, $3) RETURNING id, title, capacity, created_by, created_at',
          [title, capacity, created_by || null]
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
   * GET /jobs/:id/pipeline
   * Get the application pipeline for a job
   */
  router.get(
    '/jobs/:id/pipeline',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const jobId = req.params.id as string;

        if (!jobId) {
          return res.status(400).json({ error: 'Invalid job ID' });
        }

        // Check if job exists first
        const jobCheck = await pool.query(
          'SELECT id FROM jobs WHERE id = $1',
          [jobId]
        );

        if (jobCheck.rows.length === 0) {
          return res.status(404).json({ error: 'Job not found' });
        }

        const result = await withTransaction(pool, async (ctx) => {
          // Get job
          const jobResult = await ctx.query(
            'SELECT id, title, capacity FROM jobs WHERE id = $1',
            [jobId]
          );

          // Get applications ordered by queue position
          const applicationsResult = await ctx.query(
            `SELECT 
               a.id, a.status, a.queue_position, a.created_at as applied_at, a.ack_deadline as acknowledged_at,
               ap.name, ap.email
             FROM applications a
             JOIN applicants ap ON a.applicant_id = ap.id
             WHERE a.job_id = $1
             ORDER BY a.queue_position ASC, a.created_at ASC`,
            [jobId]
          );

          return {
            job: jobResult.rows[0],
            applications: applicationsResult.rows,
          };
        });

        return res.status(200).json(result);
      } catch (err) {
        next(err);
        return;
      }
    }
  );

  /**
   * GET /jobs/:id/metrics
   * Detailed observation data and performance metrics
   */
  router.get(
    '/jobs/:id/metrics',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const jobId = req.params.id as string;

        if (!jobId) {
          return res.status(400).json({ error: 'Invalid job ID' });
        }

        const metrics = await withTransaction(pool, async (ctx) => {
          return await getJobMetrics(ctx, jobId);
        });

        return res.status(200).json(metrics);
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
