import { Router, Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import { z } from 'zod';
import { withTransaction } from '../db/transactions';

/**
 * ============================================================================
 * APPLICANTS ROUTES
 * ============================================================================
 */

export function createApplicantRoutes(pool: Pool): Router {
  const router = Router();

  // Zod schema
  const createApplicantSchema = z.object({
    name: z.string().min(1),
    email: z.string().email(),
  });

  /**
   * POST /applicants
   * Create a new applicant
   */
  router.post('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = createApplicantSchema.safeParse(req.body);

      if (!parsed.success) {
        return res.status(400).json({
          error: 'INVALID_INPUT',
          details: parsed.error.issues,
        });
      }

      const { name, email } = parsed.data;

      const result = await withTransaction(pool, async (ctx) => {
        const query = `
          INSERT INTO applicants (name, email)
          VALUES ($1, $2)
          ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name
          RETURNING *
        `;
        const res = await ctx.query(query, [name, email]);
        return res.rows[0];
      });

      return res.status(201).json(result);
    } catch (err) {
      return next(err);
    }
  });

  /**
   * GET /applicants/:id
   * Retrieve applicant details
   */
  router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params as { id: string };
      const result = await withTransaction(pool, async (ctx) => {
        const res = await ctx.query('SELECT * FROM applicants WHERE id = $1', [id]);
        return res.rows[0];
      });

      if (!result) {
        return res.status(404).json({ error: 'Applicant not found' });
      }
      
      return res.json(result);
    } catch (err) {
      return next(err);
    }
  });

  /**
   * GET /applicants
   * List all applicants
   */
  router.get('/', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await withTransaction(pool, async (ctx) => {
        const res = await ctx.query(
          `SELECT id, name, email, created_at
           FROM applicants
           ORDER BY created_at DESC`
        );
        return res.rows;
      });
      
      return res.json(result);
    } catch (err) {
      return next(err);
    }
  });

  return router;
}
