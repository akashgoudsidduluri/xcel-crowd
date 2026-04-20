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
import { z } from 'zod';
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
import { applyLimiter, actionLimiter } from '../middlewares/rateLimiter';

export function createApplicationRoutes(pool: Pool): Router {
  const router = Router();

  // Zod schemas
  const applySchema = z.object({
    email: z.string().email(),
    name: z.string().min(1),
    jobId: z.string().uuid(),
  });

  const idSchema = z.string().uuid();

  const exitSchema = z.object({
    status: z.enum(['HIRED', 'REJECTED']),
  });

  /**
   * POST /apply
   * Applicant applies to a job
   * 
   * BODY: { email, name, jobId }
   */
  router.post('/apply', applyLimiter, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = applySchema.safeParse(req.body);

      if (!parsed.success) {
        return res.status(400).json({
          error: 'INVALID_INPUT',
          details: parsed.error.issues,
        });
      }

      const { email, name, jobId } = parsed.data;

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

      return next(err);
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
    actionLimiter,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsedId = idSchema.safeParse(req.params.id);

        if (!parsedId.success) {
          return res.status(400).json({
            error: 'INVALID_ID',
            details: parsedId.error.issues,
          });
        }

        const applicationId = parsedId.data;

        const result = await acknowledgeApplication(pool, applicationId);

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

        return next(err);
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
    actionLimiter,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsedId = idSchema.safeParse(req.params.id);

        if (!parsedId.success) {
          return res.status(400).json({
            error: 'INVALID_ID',
            details: parsedId.error.issues,
          });
        }

        const applicationId = parsedId.data;

        const result = await withdrawApplication(pool, applicationId, 'applicant_request');

        return res.status(200).json(result);
      } catch (err) {
        const error = err as Error;

        if (error.message.includes('INVALID_WITHDRAWAL')) {
          return res.status(409).json({ error: error.message });
        }

        if (error.message.includes('Application not found')) {
          return res.status(404).json({ error: error.message });
        }

        return next(err);
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
    actionLimiter,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsedId = idSchema.safeParse(req.params.id);
        const parsedBody = exitSchema.safeParse(req.body);

        if (!parsedId.success) {
          return res.status(400).json({
            error: 'INVALID_ID',
            details: parsedId.error.issues,
          });
        }

        if (!parsedBody.success) {
          return res.status(400).json({
            error: 'INVALID_INPUT',
            details: parsedBody.error.issues,
          });
        }

        const applicationId = parsedId.data;
        const { status } = parsedBody.data;

        const result = await exitApplication(pool, applicationId, status);

        return res.status(200).json(result);
      } catch (err) {
        const error = err as Error;

        if (error.message.includes('INVALID_EXIT')) {
          return res.status(409).json({ error: error.message });
        }

        return next(err);
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
        const parsedId = idSchema.safeParse(req.params.id);

        if (!parsedId.success) {
          return res.status(400).json({
            error: 'INVALID_ID',
            details: parsedId.error.issues,
          });
        }

        const applicationId = parsedId.data;

        const app = await getApplicationDetails(pool, applicationId);
        const trail = await withTransaction(pool, async (ctx) => {
          return await getAuditTrail(ctx, applicationId);
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

        return next(err);
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
