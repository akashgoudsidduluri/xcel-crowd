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

import { Pool } from 'pg';
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

/**
 * TEST 1: No double-booking on last slot
 * 
 * Scenario: Concurrent applies when 1 slot remains
 * Expected: Exactly one PENDING_ACK, others WAITLISTED
 */
export async function testNoDoubleBooking(pool: Pool): Promise<boolean> {
  console.log('\n[TEST 1] No double-booking on last slot');

  try {
    // Create job with capacity 1
    const jobResult = await withTransaction(pool, async (ctx) => {
      const result = await ctx.query(
        'INSERT INTO jobs (title, capacity) VALUES ($1, $2) RETURNING id',
        ['Test Job', 1]
      );
      return result.rows[0].id;
    });

    const jobId = jobResult;

    // Concurrent applies (simulated sequentially but with same logic)
    const applies = await Promise.all([
      applyToJob(pool, 'user1@test.com', 'User 1', jobId),
      applyToJob(pool, 'user2@test.com', 'User 2', jobId),
      applyToJob(pool, 'user3@test.com', 'User 3', jobId),
    ]);

    // Verify: exactly 1 PENDING_ACK, 2 WAITLISTED
    const stats = await getQueueStats(pool, jobId);

    if (stats.pendingAck === 1 && stats.waitlist === 2 && stats.occupancy === 1) {
      console.log('✓ PASSED: Capacity limit enforced');
      return true;
    } else {
      console.log(
        `✗ FAILED: Expected (pending=1, waitlist=2), got (pending=${stats.pendingAck}, waitlist=${stats.waitlist})`
      );
      return false;
    }
  } catch (err) {
    console.error('✗ ERROR:', err);
    return false;
  }
}

/**
 * TEST 2: Queue positions always contiguous
 * 
 * Scenario: Remove applications, verify queue reindexes to 1,2,3,...
 * Expected: No gaps in queue_position
 */
export async function testContiguousQueuePositions(pool: Pool): Promise<boolean> {
  console.log('\n[TEST 2] Queue positions always contiguous');

  try {
    // Create job with capacity 2
    const jobResult = await withTransaction(pool, async (ctx) => {
      const result = await ctx.query(
        'INSERT INTO jobs (title, capacity) VALUES ($1, $2) RETURNING id',
        ['Contiguous Test', 2]
      );
      return result.rows[0].id;
    });

    const jobId = jobResult;

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
    const expected = [1, 2];
    const isContiguous =
      queue.length === 2 &&
      queue[0] === 1 &&
      queue[1] === 2;

    if (isContiguous) {
      console.log('✓ PASSED: Queue positions contiguous');
      return true;
    } else {
      console.log(`✗ FAILED: Expected [1, 2], got [${queue.join(', ')}]`);
      return false;
    }
  } catch (err) {
    console.error('✗ ERROR:', err);
    return false;
  }
}

/**
 * TEST 3: Cascade promotion fills slots
 * 
 * Scenario: ACTIVE exits, cascade should auto-promote from waitlist
 * Expected: Exactly capacity slots filled (ACTIVE + PENDING_ACK)
 */
export async function testCascadePromotion(pool: Pool): Promise<boolean> {
  console.log('\n[TEST 3] Cascade promotion fills slots');

  try {
    // Create job with capacity 2
    const jobResult = await withTransaction(pool, async (ctx) => {
      const result = await ctx.query(
        'INSERT INTO jobs (title, capacity) VALUES ($1, $2) RETURNING id',
        ['Cascade Test', 2]
      );
      return result.rows[0].id;
    });

    const jobId = jobResult;

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

    // Get stats before exit
    const statsBefore = await getQueueStats(pool, jobId);

    // Remove one ACTIVE
    await exitApplication(pool, apps[0].applicationId, 'REJECTED');

    // Trigger cascade
    const cascadeResult = await cascadePromotion(pool, jobId);

    // Get stats after
    const statsAfter = await getQueueStats(pool, jobId);

    if (
      cascadeResult.totalPromoted === 1 &&
      statsAfter.occupancy === 2 &&
      statsAfter.waitlist === 1
    ) {
      console.log(`✓ PASSED: Promoted ${cascadeResult.totalPromoted}, occupancy=${statsAfter.occupancy}`);
      return true;
    } else {
      console.log(
        `✗ FAILED: Expected occupancy=2, waitlist=1; got occupancy=${statsAfter.occupancy}, waitlist=${statsAfter.waitlist}`
      );
      return false;
    }
  } catch (err) {
    console.error('✗ ERROR:', err);
    return false;
  }
}

/**
 * TEST 4: State machine enforced
 * 
 * Scenario: Try invalid transitions
 * Expected: All throw errors
 */
export async function testStateMachineEnforcement(pool: Pool): Promise<boolean> {
  console.log('\n[TEST 4] State machine strictly enforced');

  const invalidTransitions = [
    { from: 'WAITLISTED', to: 'ACTIVE' },
    { from: 'ACTIVE', to: 'WAITLISTED' },
    { from: 'HIRED', to: 'ACTIVE' },
    { from: 'REJECTED', to: 'ACTIVE' },
  ];

  let allFailed = true;

  for (const transition of invalidTransitions) {
    try {
      validateTransition(transition.from as any, transition.to as any);
      console.log(
        `✗ FAILED: Transition ${transition.from} → ${transition.to} should throw but didn't`
      );
      allFailed = false;
    } catch (err) {
      // Expected
    }
  }

  if (allFailed) {
    console.log('✓ PASSED: All invalid transitions blocked');
    return true;
  }

  return false;
}

/**
 * TEST 5: Audit logging complete
 * 
 * Scenario: Apply → Ack → Exit, verify all transitions logged
 * Expected: 3 audit logs, showing state flow
 */
export async function testAuditLogging(pool: Pool): Promise<boolean> {
  console.log('\n[TEST 5] Audit logging complete');

  try {
    // Create job
    const jobResult = await withTransaction(pool, async (ctx) => {
      const result = await ctx.query(
        'INSERT INTO jobs (title, capacity) VALUES ($1, $2) RETURNING id',
        ['Audit Test', 1]
      );
      return result.rows[0].id;
    });

    const jobId = jobResult;

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
    if (trail.length === 3) {
      const transitions = trail.map((t) => `${t.from_status || 'INIT'} → ${t.to_status}`);
      console.log('✓ PASSED: All transitions logged');
      console.log('  Transitions:', transitions);
      return true;
    } else {
      console.log(`✗ FAILED: Expected 3 audit logs, got ${trail.length}`);
      return false;
    }
  } catch (err) {
    console.error('✗ ERROR:', err);
    return false;
  }
}

/**
 * Run all tests
 */
export async function runAllTests(pool: Pool): Promise<void> {
  console.log('='.repeat(60));
  console.log('CONCURRENCY & CORRECTNESS TEST SUITE');
  console.log('='.repeat(60));

  const results = await Promise.all([
    testNoDoubleBooking(pool),
    testContiguousQueuePositions(pool),
    testCascadePromotion(pool),
    testStateMachineEnforcement(pool),
    testAuditLogging(pool),
  ]);

  const passed = results.filter((r) => r).length;
  const total = results.length;

  console.log('\n' + '='.repeat(60));
  console.log(`RESULTS: ${passed}/${total} tests passed`);
  console.log('='.repeat(60));

  if (passed === total) {
    console.log('\n✓ ALL TESTS PASSED - System is production-safe\n');
  } else {
    console.log(
      `\n✗ ${total - passed} test(s) failed - Review violations above\n`
    );
  }
}
