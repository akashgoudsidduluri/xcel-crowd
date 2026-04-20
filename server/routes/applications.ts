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
import { AppError, ValidationError } from '../errors';

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
        throw new ValidationError('Invalid application data', parsed.error.issues);
      }

      const { email, name, jobId } = parsed.data;

      const result = await applyToJob(pool, email, name, jobId);

      return res.status(201).json(result);
    } catch (err) {
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
          throw new ValidationError('Invalid application ID format', parsedId.error.issues);
        }

        const applicationId = parsedId.data;

        const result = await acknowledgeApplication(pool, applicationId);

        return res.status(200).json(result);
      } catch (err) {
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
          throw new ValidationError('Invalid application ID format', parsedId.error.issues);
        }

        const applicationId = parsedId.data;

        const result = await withdrawApplication(pool, applicationId, 'applicant_request');

        return res.status(200).json(result);
      } catch (err) {
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
          throw new ValidationError('Invalid application ID format', parsedId.error.issues);
        }

        if (!parsedBody.success) {
          throw new ValidationError('Invalid exit status provided', parsedBody.error.issues);
        }

        const applicationId = parsedId.data;
        const { status } = parsedBody.data;

        const result = await exitApplication(pool, applicationId, status);

        return res.status(200).json(result);
      } catch (err) {
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
          throw new ValidationError('Invalid application ID format', parsedId.error.issues);
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
          throw new AppError(
            'Job ID is required to fetch queue statistics',
            400,
            'INVALID_INPUT'
          );
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
