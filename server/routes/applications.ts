/**
 * ============================================================================
 * APPLICATIONS ROUTES
 * ============================================================================
 * 
 * HTTP API for applications (applies, acknowledgments, withdrawals, etc.)
 * 
 * CRITICAL:
 * - All business logic is in services/ (routes only handle HTTP)
 * - All mutations go through transaction-based services
 * - All errors are caught and returned with proper HTTP status
 * - NO business logic in routes
 */

import { Router, Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import {
  applyToJob,
  acknowledgeApplication,
  withdrawApplication,
  exitApplication,
  getApplicationDetails,
} from '../services/application.service';
import { getQueueStats } from '../services/promotion.service';
import { getAuditTrail } from '../services/auditLog.service';
import { withTransaction } from '../db/transactions';

export function createApplicationRoutes(pool: Pool): Router {
  const router = Router();

  /**
   * POST /apply
   * Applicant applies to a job
   * 
   * BODY: { email, name, jobId }
   */
  router.post('/apply', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { email, name, jobId } = req.body;

      // Validate input
      if (!email || !name || !jobId) {
        return res.status(400).json({
          error: 'Missing required fields: email, name, jobId',
        });
      }

      const result = await applyToJob(pool, email, name, jobId);

      return res.status(201).json(result);
    } catch (err) {
      const error = err as Error;

      if (error.message.includes('DUPLICATE_APPLICATION')) {
        return res.status(409).json({ error: error.message });
      }

      if (error.message.includes('Job not found')) {
        return res.status(404).json({ error: error.message });
      }

      next(err);
    }
  });

  /**
   * POST /applications/:id/ack
   * Applicant acknowledges and moves to ACTIVE
   * 
   * PARAMS: { id: application ID }
   */
  router.post(
    '/applications/:id/ack',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const applicationId = req.params.id;

        if (!applicationId) {
          return res.status(400).json({ error: 'Invalid application ID' });
        }

        const result = await acknowledgeApplication(pool, applicationId as string);

        return res.status(200).json(result);
      } catch (err) {
        const error = err as Error;

        if (error.message.includes('INVALID_TRANSITION')) {
          return res.status(409).json({ error: error.message });
        }

        if (error.message.includes('ACK_DEADLINE_EXPIRED')) {
          return res.status(410).json({ error: error.message });
        }

        if (error.message.includes('Application not found')) {
          return res.status(404).json({ error: error.message });
        }

        next(err);
      }
    }
  );

  /**
   * POST /applications/:id/withdraw
   * Applicant withdraws from application
   * 
   * PARAMS: { id: application ID }
   */
  router.post(
    '/applications/:id/withdraw',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const applicationId = req.params.id;

        if (!applicationId) {
          return res.status(400).json({ error: 'Invalid application ID' });
        }

        const result = await withdrawApplication(pool, applicationId as string, 'applicant_request');

        return res.status(200).json(result);
      } catch (err) {
        const error = err as Error;

        if (error.message.includes('INVALID_WITHDRAWAL')) {
          return res.status(409).json({ error: error.message });
        }

        if (error.message.includes('Application not found')) {
          return res.status(404).json({ error: error.message });
        }

        next(err);
      }
    }
  );

  /**
   * POST /applications/:id/exit
   * Recruiter marks application as HIRED or REJECTED
   * 
   * PARAMS: { id: application ID }
   * BODY: { status: 'HIRED' | 'REJECTED' }
   */
  router.post(
    '/applications/:id/exit',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const applicationId = req.params.id;
        const { status } = req.body;

        if (!applicationId) {
          return res.status(400).json({ error: 'Invalid application ID' });
        }

        if (!status || (status !== 'HIRED' && status !== 'REJECTED')) {
          return res.status(400).json({
            error: 'Body must include status: "HIRED" or "REJECTED"',
          });
        }

        const result = await exitApplication(pool, applicationId as string, status);

        return res.status(200).json(result);
      } catch (err) {
        const error = err as Error;

        if (error.message.includes('INVALID_EXIT')) {
          return res.status(409).json({ error: error.message });
        }

        if (error.message.includes('Application not found')) {
          return res.status(404).json({ error: error.message });
        }

        next(err);
      }
    }
  );

  /**
   * GET /applications/:id
   * Get application details with audit trail
   */
  router.get(
    '/applications/:id',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const applicationId = req.params.id;

        if (!applicationId) {
          return res.status(400).json({ error: 'Invalid application ID' });
        }

        const app = await getApplicationDetails(pool, applicationId as string);
        const trail = await withTransaction(pool, async (ctx) => {
          return await getAuditTrail(ctx, applicationId as string);
        });

        return res.status(200).json({
          ...app,
          auditTrail: trail,
        });
      } catch (err) {
        const error = err as Error;

        if (error.message.includes('Application not found')) {
          return res.status(404).json({ error: error.message });
        }

        next(err);
      }
    }
  );

  /**
   * GET /queue/:jobId
   * Get queue statistics and current queue for a job
   */
  router.get(
    '/queue/:jobId',
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const jobId = req.params.jobId;

        if (!jobId) {
          return res.status(400).json({ error: 'Invalid job ID' });
        }

        const stats = await getQueueStats(pool, jobId as string);

        // Get detailed queue
        const queue = await withTransaction(pool, async (ctx) => {
          const result = await ctx.query(
            `SELECT id, applicant_id, queue_position, penalty_count, created_at
             FROM applications
             WHERE job_id = $1 AND status = 'WAITLISTED'
             ORDER BY queue_position ASC`,
            [jobId]
          );
          return result.rows;
        });

        return res.status(200).json({
          stats,
          queue,
        });
      } catch (err) {
        return next(err);
      }
    }
  );

  return router;
}
