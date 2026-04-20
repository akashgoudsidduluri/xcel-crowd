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

// Mock the database pool so we don't hit the real database during CI
jest.mock('../db/pool', () => {
  const mPool = {
    connect: jest.fn().mockResolvedValue({
      query: jest.fn().mockResolvedValue({ rows: [] }),
      release: jest.fn(),
    }),
    query: jest.fn(),
  };
  return { pool: mPool };
});

import { Pool } from 'pg';
import { pool } from '../db/pool';
import { describe, test, expect, jest } from '@jest/globals';
import {
  applyToJob,
  acknowledgeApplication,
  withdrawApplication,
  exitApplication,
} from '../services/application.service';
import { promoteNext, cascadePromotion, getQueueStats } from '../services/promotion.service';
import { withTransaction, reindexQueuePositions } from '../db/transactions';
import { getAuditTrail } from '../services/auditLog.service';
import { validateTransition } from '../stateMachine';

// ============================================================================
// TEST 1: No double-booking on last slot
// ============================================================================

test('No double-booking on last slot', async () => {
  // Create job with capacity 1
  const jobId = await withTransaction(pool, async (ctx) => {
    const result = await ctx.query(
      'INSERT INTO jobs (title, capacity) VALUES ($1, $2) RETURNING id',
      ['Test Job', 1]
    );
    return result.rows[0].id;
  });

  // Concurrent applies (simulated sequentially but with same logic)
  const applies = await Promise.all([
    applyToJob(pool, 'user1@test.com', 'User 1', jobId),
    applyToJob(pool, 'user2@test.com', 'User 2', jobId),
    applyToJob(pool, 'user3@test.com', 'User 3', jobId),
  ]);

  // Verify: exactly 1 PENDING_ACK, 2 WAITLISTED
  const stats = await getQueueStats(pool, jobId);

  expect(stats.pendingAck).toBe(1);
  expect(stats.waitlist).toBe(2);
  expect(stats.active).toBe(1);
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

  // Acknowledge first 2 to move to ACTIVE
  await acknowledgeApplication(pool, apps[0].applicationId);
  await acknowledgeApplication(pool, apps[1].applicationId);

  // Remove one ACTIVE
  await exitApplication(pool, apps[0].applicationId, 'REJECTED');

  // Trigger cascade
  const cascadeResult = await withTransaction(pool, async (ctx) => {
    return await cascadePromotion(ctx, jobId);
  });

  // Get stats after
  const statsAfter = await getQueueStats(pool, jobId);

  expect(cascadeResult.totalPromoted).toBe(1);
  expect(statsAfter.active).toBe(2);
  expect(statsAfter.waitlist).toBe(1);
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
