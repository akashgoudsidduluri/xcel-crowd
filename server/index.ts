/**
 * ============================================================================
 * EXPRESS SERVER (MAIN ENTRY POINT)
 * ============================================================================
 * 
 * Production-grade ATS backend server
 * Initializes:
 * - Database pool with connection management
 * - Decay worker (background process)
 * - Express routes (applications, jobs)
 * - Error handling
 * - Request validation
 */

import express, { Express, Request, Response, NextFunction } from 'express';
import { Pool } from 'pg';
import cors from 'cors'; // Import CORS
import 'dotenv/config'; // Load environment variables from .env
import { createApplicationRoutes } from './routes/applications';
import { createJobRoutes } from './routes/jobs';
import { createApplicantRoutes } from './routes/applicants';
import { startDecayWorker, stopDecayWorker } from './services/decayWorker';
import { pool } from './db/pool';
import { errorHandler } from './middlewares/errorHandler';

/**
 * Create and configure Express app
 */
export function createApp(pool: Pool): Express {
  const app = express();
  
  // Middleware
  app.use(cors()); // Enable CORS
  app.use(express.json());

  // Request logging (production-grade)
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      console.log(
        `[${new Date().toISOString()}] ${req.method} ${req.path} ${res.statusCode} ${duration}ms`
      );
    });
    next();
  });

  // Health check
  app.get('/health', (req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });

  // Database health check
  app.get('/health/db', async (req: Request, res: Response) => {
    try {
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();
      res.status(200).json({ status: 'ok', database: 'connected' });
    } catch (err) {
      res.status(503).json({ status: 'error', database: 'disconnected' });
    }
  });

  // Routes
  app.use('/', createApplicationRoutes(pool));
  app.use('/', createJobRoutes(pool));
  app.use('/', createApplicantRoutes(pool));

  // Error handler middleware (must be last)
  app.use(errorHandler);

  return app;
}

/**
 * Start the server
 */
export async function startServer(
  port: number = 3001,
  decayWorkerInterval: number = 5000
): Promise<{
  app: Express;
  pool: Pool;
  server: any;
  close: () => Promise<void>;
}> {
  // Test connection
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    console.log('✓ Database connected');
  } catch (err) {
    console.error('✗ Database connection failed:', err);
    process.exit(1);
  }

  // Create Express app
  const app = createApp(pool);

  // Start decay worker
  startDecayWorker(pool, decayWorkerInterval);
  console.log(`✓ Decay worker started (${decayWorkerInterval}ms interval)`);

  // Start HTTP server
  const server = app.listen(port, () => {
    console.log(`✓ Server running on http://localhost:${port}`);
  });

  // Graceful shutdown
  const close = async () => {
    console.log('Shutting down...');
    stopDecayWorker();
    server.close();
    await pool.end();
    console.log('✓ Shutdown complete');
  };

  process.on('SIGINT', close);
  process.on('SIGTERM', close);

  return { app, pool, server, close };
}

// Start server if run directly
if (require.main === module) {
  const port = parseInt(process.env.PORT || '3001', 10);
  startServer(port).catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}
