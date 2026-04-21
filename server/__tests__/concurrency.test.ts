/**
 * ============================================================================
 * CONCURRENCY & CORRECTNESS TEST SUITE
 * ============================================================================
 *
 * Validates production-grade requirements:
 * 1. No double-booking (capacity always respected)
 * 2. No duplicate promotions
 * 3. Queue positions always contiguous
 * 4. State machine strictly enforced
 * 5. Audit logging complete
 * 6. Race condition safety
 */

import { test, expect, beforeEach, afterAll } from '@jest/globals';
import { Pool } from 'pg';

// Use real PostgreSQL database for testing
const pool = new Pool({
  user: process.env.DB_TEST_USER || 'postgres',
  password: process.env.DB_TEST_PASSWORD || 'postgres',
  host: process.env.DB_TEST_HOST || 'localhost',
  port: parseInt(process.env.DB_TEST_PORT || '5432', 10),
  database: process.env.DB_TEST_DATABASE || 'xcelcrowd_test',
});

beforeEach(async () => {
  // Setup test database
  try {
    const client = await pool.connect();
    // Ensure a pristine state by truncating all related tables
    await client.query('TRUNCATE jobs, applicants, applications, audit_logs RESTART IDENTITY CASCADE');
    client.release();
  } catch (err) {
    console.error('Failed to connect to test database:', err);
    process.exit(1);
  }
});

afterAll(async () => {
  // Cleanup and close pool
  await pool.end();
});
import {
  applyToJob,
  acknowledgeApplication,
  exitApplication,
} from '../services/application.service';
import { getQueueStats, cascadePromotion } from '../services/promotion.service';
import { withTransaction } from '../db/transactions';
import { getAuditTrail } from '../services/auditLog.service';
import { validateTransition } from '../stateMachine';

// ============================================================================
// TEST 1: No double-booking on last slot
// ============================================================================

test('No double-booking on last slot', async () => {
  const jobId = await withTransaction(pool, async (ctx) => {
    const result = await ctx.query(
      'INSERT INTO jobs (title, capacity) VALUES ($1, $2) RETURNING id',
      ['Test Job', 1]
    );
    return result.rows[0].id;
  });

  // 🔥 AGGRESSIVE: 20 concurrent applies for 1 slot
  const applies = await Promise.all([
    ...Array.from({ length: 20 }, (_, i) => 
      applyToJob(pool, `race${i}@test.com`, `User ${i}`, jobId)
    )
  ]);

  const stats = await getQueueStats(pool, jobId);
  const queue = await withTransaction(pool, async (ctx) => {
    const result = await ctx.query(
      "SELECT queue_position FROM applications WHERE job_id = $1 AND status = 'WAITLISTED' ORDER BY queue_position",
      [jobId]
    );
    return result.rows.map(r => r.queue_position);
  });

  // ASSERTIONS
  expect(stats.pendingAck).toBe(1);
  expect(stats.waitlist).toBe(19);
  expect(stats.active + stats.pendingAck).toBeLessThanOrEqual(stats.capacity);
  expect(queue[0]).toBe(1);
  expect(queue[18]).toBe(19);
  expect(queue.every((p, i) => p === i + 1)).toBe(true);
});

// ============================================================================
// TEST 5: Multi-worker decay race
// ============================================================================

test('Multi-worker decay race safety', async () => {
  const jobId = await withTransaction(pool, async (ctx) => {
    const result = await ctx.query(
      'INSERT INTO jobs (title, capacity) VALUES ($1, $2) RETURNING id',
      ['Multi-Worker Decay', 5]
    );
    return result.rows[0].id;
  });

  // Setup 5 expired applications
  await Promise.all(Array.from({ length: 5 }, (_, i) => 
    applyToJob(pool, `decay_race${i}@test.com`, `User ${i}`, jobId)
  ));
  
  await pool.query(
    "UPDATE applications SET ack_deadline = NOW() - INTERVAL '1 hour' WHERE job_id = $1",
    [jobId]
  );

  // 🔥 AGGRESSIVE: Simulate two decay workers firing at the exact same time
  // This tests FOR UPDATE SKIP LOCKED
  const { processDecayedApplications } = require('../services/decayWorker');
  await Promise.all([
    processDecayedApplications(pool),
    processDecayedApplications(pool)
  ]);

  const stats = await getQueueStats(pool, jobId);
  const auditCounts = await pool.query(
    "SELECT COUNT(*) FROM audit_logs l JOIN applications a ON l.application_id = a.id WHERE a.job_id = $1 AND l.to_status = 'WAITLISTED'",
    [jobId]
  );

  // ASSERTIONS
  expect(stats.pendingAck).toBe(0);
  expect(stats.waitlist).toBe(5);
  expect(parseInt(auditCounts.rows[0].count)).toBe(5); // No double transitions logged
  const queue = await pool.query("SELECT queue_position FROM applications WHERE job_id = $1 ORDER BY queue_position", [jobId]);
  expect(queue.rows.map(r => r.queue_position)).toEqual([1, 2, 3, 4, 5]);
});


// ============================================================================
// TEST 2: Queue positions always contiguous
// ============================================================================

test('Queue positions always contiguous', async () => {
  // Create job with capacity 2
  const jobId = await withTransaction(pool, async (ctx) => {
    const result = await ctx.query(
      'INSERT INTO jobs (title, capacity) VALUES ($1, $2) RETURNING id',
      ['Contiguous Test', 2]
    );
    return result.rows[0].id;
  });

  // Apply 4 applicants (2 in slots, 2 waitlisted)
  const apps = await Promise.all([
    applyToJob(pool, 'user1@test.com', 'User 1', jobId),
    applyToJob(pool, 'user2@test.com', 'User 2', jobId),
    applyToJob(pool, 'user3@test.com', 'User 3', jobId),
    applyToJob(pool, 'user4@test.com', 'User 4', jobId),
  ]);

  // Get queue
  const queue = await withTransaction(pool, async (ctx) => {
    const result = await ctx.query(
      `SELECT queue_position FROM applications WHERE job_id = $1 AND status = 'WAITLISTED' ORDER BY queue_position`,
      [jobId]
    );
    return result.rows.map((r) => r.queue_position);
  });

  // Verify contiguous
  expect(queue).toEqual([1, 2]);
  expect(queue.length).toBe(2);
  expect(queue.every((position, index) => position === index + 1)).toBe(true);
});

// ============================================================================
// TEST 3: Cascade promotion fills slots
// ============================================================================

test('Cascade promotion fills slots', async () => {
  // Create job with capacity 2
  const jobId = await withTransaction(pool, async (ctx) => {
    const result = await ctx.query(
      'INSERT INTO jobs (title, capacity) VALUES ($1, $2) RETURNING id',
      ['Cascade Test', 2]
    );
    return result.rows[0].id;
  });

  // Apply 4 applicants
  const apps = await Promise.all([
    applyToJob(pool, 'user1@test.com', 'User 1', jobId),
    applyToJob(pool, 'user2@test.com', 'User 2', jobId),
    applyToJob(pool, 'user3@test.com', 'User 3', jobId),
    applyToJob(pool, 'user4@test.com', 'User 4', jobId),
  ]);

  const pendingAckApps = apps.filter((app) => app.status === 'PENDING_ACK');
  expect(pendingAckApps).toHaveLength(2);

  // Acknowledge the applicants that actually acquired the available slots.
  await acknowledgeApplication(pool, pendingAckApps[0].applicationId);
  await acknowledgeApplication(pool, pendingAckApps[1].applicationId);

  // Remove one ACTIVE
  await exitApplication(pool, pendingAckApps[0].applicationId, 'REJECTED');

  // Trigger cascade again; it should be a no-op because exitApplication
  // already filled the freed slot atomically.
  const cascadeResult = await withTransaction(pool, async (ctx) => {
    return await cascadePromotion(ctx, jobId);
  });

  // Get stats after
  const statsAfter = await getQueueStats(pool, jobId);
  const queueAfter = await withTransaction(pool, async (ctx) => {
    const result = await ctx.query(
      `SELECT applicant_id, queue_position
       FROM applications
       WHERE job_id = $1 AND status = 'WAITLISTED'
       ORDER BY queue_position ASC`,
      [jobId]
    );
    return result.rows;
  });

  expect(cascadeResult.totalPromoted).toBe(0);
  expect(cascadeResult.promoted).toEqual([]);
  expect(statsAfter.active + statsAfter.pendingAck).toBeLessThanOrEqual(statsAfter.capacity);
  expect(statsAfter.waitlist).toBe(1);
  expect(queueAfter).toEqual([
    expect.objectContaining({
      applicant_id: expect.any(String),
      queue_position: 1,
    }),
  ]);
});

// ============================================================================
// TEST 4: State machine enforced
// ============================================================================

test('State machine strictly enforced', async () => {
  const invalidTransitions = [
    { from: 'WAITLISTED', to: 'ACTIVE' },
    { from: 'ACTIVE', to: 'WAITLISTED' },
    { from: 'HIRED', to: 'ACTIVE' },
    { from: 'REJECTED', to: 'ACTIVE' },
  ];

  for (const transition of invalidTransitions) {
    expect(() => validateTransition(transition.from as any, transition.to as any)).toThrow();
  }
});

// ============================================================================
// TEST 5: Audit logging complete
// ============================================================================

test('Audit logging complete', async () => {
  // Create job
  const jobId = await withTransaction(pool, async (ctx) => {
    const result = await ctx.query(
      'INSERT INTO jobs (title, capacity) VALUES ($1, $2) RETURNING id',
      ['Audit Test', 1]
    );
    return result.rows[0].id;
  });

  // Apply
  const app = await applyToJob(pool, 'user@test.com', 'User', jobId);

  // Acknowledge
  await acknowledgeApplication(pool, app.applicationId);

  // Exit
  await exitApplication(pool, app.applicationId, 'HIRED');

  // Get audit trail
  const trail = await withTransaction(pool, async (ctx) => {
    return await getAuditTrail(ctx, app.applicationId);
  });

  // Verify 3 transitions logged
  expect(trail.length).toBe(3);
});
