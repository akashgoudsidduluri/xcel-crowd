/**
 * ============================================================================
 * AGGRESSIVE STRESS TEST SUITE
 * ============================================================================
 * 
 * GOAL: BREAK the system and expose flaws
 * Assume bugs exist. Test rigorously.
 * 
 * Tests cover:
 * 1. Race conditions (last slot)
 * 2. Duplicate applications
 * 3. Multi-job applications
 * 4. Acknowledgment flow
 * 5. Decay mechanism
 * 6. Cascade promotion
 * 7. Queue integrity
 * 8. Concurrent promotion
 * 9. Withdrawal flow
 * 10. Audit logging
 * 11. Load test (100+ concurrent)
 */

import { Pool } from 'pg';
import {
  applyToJob,
  acknowledgeApplication,
  withdrawApplication,
  exitApplication,
} from '../services/application.service';
import { promoteNext, cascadePromotion, getQueueStats } from '../services/promotion.service';
import { withTransaction, getQueueState } from '../db/transactions';
import { getAuditTrail } from '../services/auditLog.service';
import { startDecayWorker, stopDecayWorker } from '../services/decayWorker';

// Test result tracking
interface TestResult {
  name: string;
  passed: boolean;
  error?: string;
  details?: string;
}

const results: TestResult[] = [];

function pass(name: string, details?: string) {
  console.log(`✅ PASS: ${name}`);
  if (details) console.log(`   ${details}`);
  results.push({ name, passed: true, details });
}

function fail(name: string, error: string, details?: string) {
  console.error(`❌ FAIL: ${name}`);
  console.error(`   Error: ${error}`);
  if (details) console.error(`   Details: ${details}`);
  results.push({ name, passed: false, error, details });
}

// ============================================================================
// TEST 1: RACE CONDITION ON LAST SLOT
// ============================================================================

export async function test1RaceConditionLastSlot(pool: Pool): Promise<void> {
  console.log('\n' + '='.repeat(70));
  console.log('TEST 1: RACE CONDITION (Last Slot)');
  console.log('='.repeat(70));

  try {
    // Create job with capacity 1
    const jobId = await withTransaction(pool, async (ctx) => {
      const result = await ctx.query(
        'INSERT INTO jobs (title, capacity) VALUES ($1, $2) RETURNING id',
        ['Race Test Job', 1]
      );
      return result.rows[0].id;
    });

    // Fire 2 concurrent apply requests
    const applies = await Promise.all([
      applyToJob(pool, 'racer1@test.com', 'Racer 1', jobId),
      applyToJob(pool, 'racer2@test.com', 'Racer 2', jobId),
    ]);

    // Check results
    const stats = await getQueueStats(pool, jobId);
    const occupancy = stats.active + stats.pendingAck;

    // Validation: exactly 1 PENDING_ACK, 1 WAITLISTED
    if (stats.pendingAck === 1 && stats.waitlist === 1) {
      pass('Race condition last slot', `PENDING_ACK=1, WAITLIST=1, occupancy=${occupancy}`);
    } else {
      fail(
        'Race condition last slot',
        `Expected (pending=1, waitlist=1), got (pending=${stats.pendingAck}, waitlist=${stats.waitlist})`,
        `OCCUPANCY=${occupancy} (capacity=${stats.capacity})`
      );
    }

    // CRITICAL: Check capacity never exceeded
    if (occupancy > stats.capacity) {
      fail(
        'Race condition last slot - CRITICAL',
        `CAPACITY EXCEEDED! occupancy=${occupancy} > capacity=${stats.capacity}`,
        'This is a severe concurrency bug'
      );
    }
  } catch (err) {
    fail('Race condition last slot', (err as Error).message);
  }
}

// ============================================================================
// TEST 2: DUPLICATE APPLICATION TEST
// ============================================================================

export async function test2DuplicateApplication(pool: Pool): Promise<void> {
  console.log('\n' + '='.repeat(70));
  console.log('TEST 2: DUPLICATE APPLICATION');
  console.log('='.repeat(70));

  try {
    const jobId = await withTransaction(pool, async (ctx) => {
      const result = await ctx.query(
        'INSERT INTO jobs (title, capacity) VALUES ($1, $2) RETURNING id',
        ['Duplicate Test Job', 5]
      );
      return result.rows[0].id;
    });

    // First apply
    const app1 = await applyToJob(pool, 'duplicate@test.com', 'Duplicate User', jobId);

    // Try to apply again (same job + email)
    try {
      const app2 = await applyToJob(pool, 'duplicate@test.com', 'Duplicate User', jobId);
      fail(
        'Duplicate application',
        'Second application was accepted (should have been rejected)',
        `app1=${app1.applicationId}, app2=${app2.applicationId}`
      );
    } catch (err) {
      if ((err as Error).message.includes('DUPLICATE_APPLICATION')) {
        pass('Duplicate application', `Correctly rejected: ${(err as Error).message}`);
      } else {
        fail('Duplicate application', `Wrong error type: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    fail('Duplicate application', (err as Error).message);
  }
}

// ============================================================================
// TEST 3: MULTI-JOB APPLICATION TEST
// ============================================================================

export async function test3MultiJobApplication(pool: Pool): Promise<void> {
  console.log('\n' + '='.repeat(70));
  console.log('TEST 3: MULTI-JOB APPLICATION (Same Applicant, Different Jobs)');
  console.log('='.repeat(70));

  try {
    // Create 2 jobs
    const [job1, job2] = await withTransaction(pool, async (ctx) => {
      const j1 = await ctx.query('INSERT INTO jobs (title, capacity) VALUES ($1, $2) RETURNING id', [
        'Multi Job 1',
        3,
      ]);
      const j2 = await ctx.query('INSERT INTO jobs (title, capacity) VALUES ($1, $2) RETURNING id', [
        'Multi Job 2',
        3,
      ]);
      return [j1.rows[0].id, j2.rows[0].id];
    });

    // Same applicant applies to both
    const app1 = await applyToJob(pool, 'multijob@test.com', 'Multi Job User', job1);
    const app2 = await applyToJob(pool, 'multijob@test.com', 'Multi Job User', job2);

    // Both should succeed
    if (
      app1.applicationId !== undefined &&
      app2.applicationId !== undefined &&
      app1.applicationId !== app2.applicationId
    ) {
      pass('Multi-job application', `app1=${app1.applicationId}, app2=${app2.applicationId}`);
    } else {
      fail(
        'Multi-job application',
        'Same applicant could not apply to different jobs',
        `app1=${app1.applicationId}, app2=${app2.applicationId}`
      );
    }
  } catch (err) {
    fail('Multi-job application', (err as Error).message);
  }
}

// ============================================================================
// TEST 4: ACK FLOW TEST
// ============================================================================

export async function test4AckFlow(pool: Pool): Promise<void> {
  console.log('\n' + '='.repeat(70));
  console.log('TEST 4: ACKNOWLEDGMENT FLOW');
  console.log('='.repeat(70));

  try {
    const jobId = await withTransaction(pool, async (ctx) => {
      const result = await ctx.query(
        'INSERT INTO jobs (title, capacity) VALUES ($1, $2) RETURNING id',
        ['Ack Test', 1]
      );
      return result.rows[0].id;
    });

    // Apply (should get PENDING_ACK)
    const app = await applyToJob(pool, 'ack@test.com', 'Ack User', jobId);

    if (app.status !== 'PENDING_ACK') {
      fail('ACK flow', `Expected PENDING_ACK, got ${app.status}`);
      return;
    }

    // Acknowledge
    const acked = await acknowledgeApplication(pool, app.applicationId);

    if (acked.status === 'ACTIVE') {
      pass('ACK flow', `Successfully transitioned PENDING_ACK → ACTIVE`);
    } else {
      fail('ACK flow', `Expected ACTIVE after ack, got ${acked.status}`);
    }

    // Verify audit trail
    const trail = await withTransaction(pool, async (ctx) => {
      return await getAuditTrail(ctx, app.applicationId);
    });

    const hasTransition = trail.some((t) => t.from_status === 'PENDING_ACK' && t.to_status === 'ACTIVE');

    if (hasTransition) {
      pass('ACK flow - audit', 'Transition logged correctly');
    } else {
      fail('ACK flow - audit', 'Transition not logged', `Audit trail length: ${trail.length}`);
    }
  } catch (err) {
    fail('ACK flow', (err as Error).message);
  }
}

// ============================================================================
// TEST 5: DECAY TEST
// ============================================================================

export async function test5Decay(pool: Pool): Promise<void> {
  console.log('\n' + '='.repeat(70));
  console.log('TEST 5: DECAY MECHANISM');
  console.log('='.repeat(70));

  try {
    // Start decay worker with 1 second interval for testing
    startDecayWorker(pool, 1000);

    const jobId = await withTransaction(pool, async (ctx) => {
      const result = await ctx.query(
        'INSERT INTO jobs (title, capacity) VALUES ($1, $2) RETURNING id',
        ['Decay Test', 2]
      );
      return result.rows[0].id;
    });

    // Apply 3 users
    const app1 = await applyToJob(pool, 'decay1@test.com', 'Decay 1', jobId);
    const app2 = await applyToJob(pool, 'decay2@test.com', 'Decay 2', jobId);
    const app3 = await applyToJob(pool, 'decay3@test.com', 'Decay 3', jobId);

    // First two should be PENDING_ACK, third WAITLISTED
    if (app1.status !== 'PENDING_ACK' || app2.status !== 'PENDING_ACK' || app3.status !== 'WAITLISTED') {
      fail('Decay test setup', 'Initial states incorrect', `app1=${app1.status}, app2=${app2.status}, app3=${app3.status}`);
      stopDecayWorker();
      return;
    }

    // Manually set ack_deadline to past for app1 (simulate expiry)
    await withTransaction(pool, async (ctx) => {
      await ctx.query(
        `UPDATE applications SET ack_deadline = NOW() - INTERVAL '1 hour' WHERE id = $1`,
        [app1.applicationId]
      );
    });

    // Wait for decay worker to process
    console.log('   Waiting for decay worker (3 seconds)...');
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Check app1 status
    const app1Check = await withTransaction(pool, async (ctx) => {
      const result = await ctx.query('SELECT status, penalty_count FROM applications WHERE id = $1', [
        app1.applicationId,
      ]);
      return result.rows[0];
    });

    if (app1Check.status === 'WAITLISTED') {
      pass('Decay test - status', `App1 moved to WAITLISTED with penalty=${app1Check.penalty_count}`);
    } else {
      fail(
        'Decay test - status',
        `Expected WAITLISTED after decay, got ${app1Check.status}`,
        'Decay worker may not have processed'
      );
    }

    // Check if app3 was promoted to PENDING_ACK
    const app3Check = await withTransaction(pool, async (ctx) => {
      const result = await ctx.query('SELECT status FROM applications WHERE id = $1', [app3.applicationId]);
      return result.rows[0];
    });

    if (app3Check.status === 'PENDING_ACK') {
      pass('Decay test - cascade', `App3 promoted to PENDING_ACK`);
    } else {
      fail('Decay test - cascade', `Expected app3 promoted to PENDING_ACK, got ${app3Check.status}`);
    }

    stopDecayWorker();
  } catch (err) {
    stopDecayWorker();
    fail('Decay test', (err as Error).message);
  }
}

// ============================================================================
// TEST 6: CASCADE PROMOTION TEST
// ============================================================================

export async function test6CascadePromotion(pool: Pool): Promise<void> {
  console.log('\n' + '='.repeat(70));
  console.log('TEST 6: CASCADE PROMOTION');
  console.log('='.repeat(70));

  try {
    const jobId = await withTransaction(pool, async (ctx) => {
      const result = await ctx.query(
        'INSERT INTO jobs (title, capacity) VALUES ($1, $2) RETURNING id',
        ['Cascade Test', 2]
      );
      return result.rows[0].id;
    });

    // Apply 4 users
    const apps = await Promise.all([
      applyToJob(pool, 'cascade1@test.com', 'Cascade 1', jobId),
      applyToJob(pool, 'cascade2@test.com', 'Cascade 2', jobId),
      applyToJob(pool, 'cascade3@test.com', 'Cascade 3', jobId),
      applyToJob(pool, 'cascade4@test.com', 'Cascade 4', jobId),
    ]);

    // First 2 should be PENDING_ACK, last 2 WAITLISTED
    const statsBefore = await getQueueStats(pool, jobId);

    // Acknowledge first 2
    await acknowledgeApplication(pool, apps[0].applicationId);
    await acknowledgeApplication(pool, apps[1].applicationId);

    // Exit (REJECT) first user - should open slot
    await exitApplication(pool, apps[0].applicationId, 'REJECTED');

    // Trigger cascade
    const cascade = await cascadePromotion(pool, jobId);

    // Verify promotions
    const statsAfter = await getQueueStats(pool, jobId);
    const occupancyBefore = statsBefore.active + statsBefore.pendingAck;
    const occupancyAfter = statsAfter.active + statsAfter.pendingAck;

    if (cascade.totalPromoted >= 1) {
      pass('Cascade promotion', `Promoted ${cascade.totalPromoted} applicant(s)`);
    } else {
      fail('Cascade promotion', `Expected at least 1 promotion, got ${cascade.totalPromoted}`);
    }

    // Check occupancy still valid
    if (occupancyAfter <= statsAfter.capacity) {
      pass('Cascade promotion - capacity', `Occupancy=${occupancyAfter} ≤ capacity=${statsAfter.capacity}`);
    } else {
      fail(
        'Cascade promotion - capacity',
        `CAPACITY EXCEEDED! occupancy=${occupancyAfter} > capacity=${statsAfter.capacity}`
      );
    }

    // Check waitlist reduced
    if (statsAfter.waitlist < statsBefore.waitlist) {
      pass('Cascade promotion - waitlist', `Waitlist reduced from ${statsBefore.waitlist} to ${statsAfter.waitlist}`);
    } else {
      fail(
        'Cascade promotion - waitlist',
        `Waitlist not reduced: before=${statsBefore.waitlist}, after=${statsAfter.waitlist}`
      );
    }
  } catch (err) {
    fail('Cascade promotion', (err as Error).message);
  }
}

// ============================================================================
// TEST 7: QUEUE INTEGRITY TEST
// ============================================================================

export async function test7QueueIntegrity(pool: Pool): Promise<void> {
  console.log('\n' + '='.repeat(70));
  console.log('TEST 7: QUEUE INTEGRITY (Contiguous Positions)');
  console.log('='.repeat(70));

  try {
    const jobId = await withTransaction(pool, async (ctx) => {
      const result = await ctx.query(
        'INSERT INTO jobs (title, capacity) VALUES ($1, $2) RETURNING id',
        ['Queue Integrity Test', 3]
      );
      return result.rows[0].id;
    });

    // Apply 10 users
    const apps = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        applyToJob(pool, `queue${i}@test.com`, `Queue User ${i}`, jobId)
      )
    );

    // Acknowledge first 3
    for (let i = 0; i < 3; i++) {
      await acknowledgeApplication(pool, apps[i].applicationId);
    }

    // Trigger cascade promotions multiple times
    for (let i = 0; i < 3; i++) {
      await cascadePromotion(pool, jobId);
    }

    // Check queue positions
    const queue = await withTransaction(pool, async (ctx) => {
      return await getQueueState(ctx, jobId);
    });

    // Extract positions
    const positions = queue.map((q: any) => q.queue_position).sort((a: number, b: number) => a - b);

    // Verify contiguous starting from 1
    let isContiguous = true;
    let error = '';

    if (positions.length === 0) {
      pass('Queue integrity', 'No items in waitlist (all promoted or filled)');
      return;
    }

    if (positions[0] !== 1) {
      isContiguous = false;
      error = `First position is ${positions[0]}, not 1`;
    }

    for (let i = 1; i < positions.length; i++) {
      if (positions[i] !== positions[i - 1] + 1) {
        isContiguous = false;
        error = `Gap found: ${positions[i - 1]} → ${positions[i]}`;
        break;
      }
    }

    if (isContiguous) {
      pass('Queue integrity', `Positions contiguous: [${positions.join(', ')}]`);
    } else {
      fail('Queue integrity', error, `Positions: [${positions.join(', ')}]`);
    }
  } catch (err) {
    fail('Queue integrity', (err as Error).message);
  }
}

// ============================================================================
// TEST 8: CONCURRENT PROMOTION TEST
// ============================================================================

export async function test8ConcurrentPromotion(pool: Pool): Promise<void> {
  console.log('\n' + '='.repeat(70));
  console.log('TEST 8: CONCURRENT PROMOTION (No Duplicates)');
  console.log('='.repeat(70));

  try {
    const jobId = await withTransaction(pool, async (ctx) => {
      const result = await ctx.query(
        'INSERT INTO jobs (title, capacity) VALUES ($1, $2) RETURNING id',
        ['Concurrent Promotion', 2]
      );
      return result.rows[0].id;
    });

    // Apply 5 users
    const apps = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        applyToJob(pool, `concur${i}@test.com`, `Concurrent User ${i}`, jobId)
      )
    );

    // Acknowledge first 2
    await acknowledgeApplication(pool, apps[0].applicationId);
    await acknowledgeApplication(pool, apps[1].applicationId);

    // Exit first user
    await exitApplication(pool, apps[0].applicationId, 'REJECTED');

    // Fire multiple promotion requests concurrently
    const promotions = await Promise.all([
      promoteNext(pool, jobId),
      promoteNext(pool, jobId),
      promoteNext(pool, jobId),
    ]);

    // Only one should succeed, others should return null
    const promotedCount = promotions.filter((p) => p !== null).length;

    if (promotedCount === 1) {
      pass('Concurrent promotion', `Only 1 promotion succeeded (others correctly returned null)`);
    } else {
      fail(
        'Concurrent promotion',
        `Expected 1 promotion, got ${promotedCount}`,
        'This could lead to duplicate promotions'
      );
    }

    // Verify same applicant not promoted multiple times
    const promotedIds = promotions.filter((p) => p !== null).map((p) => p!.applicationId);
    const uniqueIds = new Set(promotedIds);

    if (uniqueIds.size === promotedIds.length) {
      pass('Concurrent promotion - uniqueness', 'No duplicate promotions');
    } else {
      fail(
        'Concurrent promotion - uniqueness',
        'Same applicant promoted multiple times',
        `Promoted IDs: ${promotedIds.join(', ')}`
      );
    }
  } catch (err) {
    fail('Concurrent promotion', (err as Error).message);
  }
}

// ============================================================================
// TEST 9: WITHDRAWAL TEST
// ============================================================================

export async function test9Withdrawal(pool: Pool): Promise<void> {
  console.log('\n' + '='.repeat(70));
  console.log('TEST 9: WITHDRAWAL FLOW');
  console.log('='.repeat(70));

  try {
    const jobId = await withTransaction(pool, async (ctx) => {
      const result = await ctx.query(
        'INSERT INTO jobs (title, capacity) VALUES ($1, $2) RETURNING id',
        ['Withdrawal Test', 2]
      );
      return result.rows[0].id;
    });

    // Apply 3 users
    const apps = await Promise.all([
      applyToJob(pool, 'withdraw1@test.com', 'Withdraw 1', jobId),
      applyToJob(pool, 'withdraw2@test.com', 'Withdraw 2', jobId),
      applyToJob(pool, 'withdraw3@test.com', 'Withdraw 3', jobId),
    ]);

    // Acknowledge first 2
    await acknowledgeApplication(pool, apps[0].applicationId);
    await acknowledgeApplication(pool, apps[1].applicationId);

    const statsBefore = await getQueueStats(pool, jobId);
    const occupancyBefore = statsBefore.active + statsBefore.pendingAck;

    // Withdraw from ACTIVE
    await withdrawApplication(pool, apps[0].applicationId);

    const statsAfter = await getQueueStats(pool, jobId);
    const occupancyAfter = statsAfter.active + statsAfter.pendingAck;

    // Verify slot was freed and cascade triggered
    if (occupancyAfter < occupancyBefore) {
      pass('Withdrawal', `Occupancy decreased: ${occupancyBefore} → ${occupancyAfter}`);
    } else {
      fail(
        'Withdrawal',
        'Slot not freed after withdrawal',
        `Occupancy: before=${occupancyBefore}, after=${occupancyAfter}`
      );
    }

    // Check if waitlist was promoted
    const app3Check = await withTransaction(pool, async (ctx) => {
      const result = await ctx.query('SELECT status FROM applications WHERE id = $1', [apps[2].applicationId]);
      return result.rows[0].status;
    });

    if (app3Check === 'PENDING_ACK') {
      pass('Withdrawal - cascade', 'Waitlisted applicant promoted after withdrawal');
    } else {
      fail('Withdrawal - cascade', `Expected app3 promoted to PENDING_ACK, got ${app3Check}`);
    }
  } catch (err) {
    fail('Withdrawal', (err as Error).message);
  }
}

// ============================================================================
// TEST 10: AUDIT LOGGING TEST
// ============================================================================

export async function test10AuditLogging(pool: Pool): Promise<void> {
  console.log('\n' + '='.repeat(70));
  console.log('TEST 10: AUDIT LOGGING (Complete Trail)');
  console.log('='.repeat(70));

  try {
    const jobId = await withTransaction(pool, async (ctx) => {
      const result = await ctx.query(
        'INSERT INTO jobs (title, capacity) VALUES ($1, $2) RETURNING id',
        ['Audit Test', 1]
      );
      return result.rows[0].id;
    });

    // Perform operations
    const app = await applyToJob(pool, 'audit@test.com', 'Audit User', jobId);
    await acknowledgeApplication(pool, app.applicationId);
    await exitApplication(pool, app.applicationId, 'HIRED');

    // Get audit trail
    const trail = await withTransaction(pool, async (ctx) => {
      return await getAuditTrail(ctx, app.applicationId);
    });

    // Should have 3 logs
    if (trail.length === 3) {
      pass('Audit logging', `3 transitions logged as expected`);
    } else {
      fail('Audit logging', `Expected 3 logs, got ${trail.length}`);
    }

    // Verify transition sequence
    const expectedSequence = [
      ['null', 'PENDING_ACK'],
      ['PENDING_ACK', 'ACTIVE'],
      ['ACTIVE', 'HIRED'],
    ];

    let sequenceCorrect = true;
    for (let i = 0; i < Math.min(3, trail.length); i++) {
      const [fromExpected, toExpected] = expectedSequence[i];
      const fromActual = trail[i].from_status;
      const toActual = trail[i].to_status;

      if (toActual !== toExpected || (fromExpected !== 'null' && fromActual !== fromExpected)) {
        sequenceCorrect = false;
        fail('Audit logging', `Log ${i}: expected ${fromExpected}→${toExpected}, got ${fromActual}→${toActual}`);
        break;
      }
    }

    if (sequenceCorrect && trail.length === 3) {
      pass('Audit logging - sequence', 'Transition sequence correct');
    }
  } catch (err) {
    fail('Audit logging', (err as Error).message);
  }
}

// ============================================================================
// TEST 11: LOAD TEST (50-100 Concurrent)
// ============================================================================

export async function test11LoadTest(pool: Pool): Promise<void> {
  console.log('\n' + '='.repeat(70));
  console.log('TEST 11: LOAD TEST (50-100 Concurrent Applications)');
  console.log('='.repeat(70));

  try {
    const jobId = await withTransaction(pool, async (ctx) => {
      const result = await ctx.query(
        'INSERT INTO jobs (title, capacity) VALUES ($1, $2) RETURNING id',
        ['Load Test', 20] // capacity 20 for 100 applications
      );
      return result.rows[0].id;
    });

    console.log('   Firing 100 concurrent apply requests...');

    // Fire 100 concurrent applies
    const startTime = Date.now();
    const promises = Array.from({ length: 100 }, (_, i) =>
      applyToJob(pool, `load${i}@test.com`, `Load User ${i}`, jobId).catch((err) => ({
        error: err.message,
      }))
    );

    const results = await Promise.all(promises);
    const endTime = Date.now();

    // Check for errors
    const errors = results.filter((r: any) => r.error);
    const successes = results.filter((r: any) => !r.error);

    console.log(`   Completed in ${endTime - startTime}ms`);
    console.log(`   Successes: ${successes.length}, Errors: ${errors.length}`);

    if (errors.length === 0) {
      pass('Load test - no errors', `All 100 requests succeeded`);
    } else {
      fail('Load test - errors', `${errors.length} requests failed`, `First error: ${errors[0].error}`);
    }

    // Check final state
    const stats = await getQueueStats(pool, jobId);
    const occupancy = stats.active + stats.pendingAck;

    if (occupancy > stats.capacity) {
      fail(
        'Load test - capacity',
        `CAPACITY EXCEEDED! occupancy=${occupancy} > capacity=${stats.capacity}`,
        'Critical: concurrent applies exceeded capacity'
      );
    } else {
      pass('Load test - capacity', `Capacity maintained: ${occupancy}/${stats.capacity}`);
    }

    // Verify queue integrity
    let positions: number[] = [];
    try {
      const queue = await withTransaction(pool, async (ctx) => {
        return await getQueueState(ctx, jobId);
      });
      positions = queue.map((q: any) => q.queue_position).sort((a: number, b: number) => a - b);
    } catch (err) {
      fail('Load test - queue integrity', 'Could not verify positions: ' + (err as Error).message);
      return;
    }

    let isContiguous = true;
    if (positions.length > 0) {
      if (positions[0] !== 1) {
        isContiguous = false;
      }
      for (let i = 1; i < positions.length; i++) {
        if (positions[i] !== positions[i - 1] + 1) {
          isContiguous = false;
          break;
        }
      }
    }

    if (isContiguous) {
      pass('Load test - queue integrity', `Queue contiguous: ${positions.length} items`);
    } else {
      fail('Load test - queue integrity', 'Queue positions have gaps', `Positions: [${positions.join(', ')}]`);
    }

    // Summary
    console.log(`\n   Summary:`);
    console.log(`   - PENDING_ACK: ${stats.pendingAck}`);
    console.log(`   - ACTIVE: ${stats.active}`);
    console.log(`   - WAITLIST: ${stats.waitlist}`);
    console.log(`   - Occupancy: ${occupancy}/${stats.capacity}`);
  } catch (err) {
    fail('Load test', (err as Error).message);
  }
}

// ============================================================================
// TEST 12: STATE MACHINE ENFORCEMENT
// ============================================================================

export async function test12StateMachineEnforcement(pool: Pool): Promise<void> {
  console.log('\n' + '='.repeat(70));
  console.log('TEST 12: STATE MACHINE ENFORCEMENT');
  console.log('='.repeat(70));

  try {
    // Test invalid transitions
    const invalidTransitions = [
      ['WAITLISTED', 'ACTIVE'],
      ['WAITLISTED', 'HIRED'],
      ['ACTIVE', 'WAITLISTED'],
      ['HIRED', 'ACTIVE'],
      ['REJECTED', 'PENDING_ACK'],
      ['INACTIVE', 'ACTIVE'],
    ];

    const { validateTransition } = await import('../stateMachine');

    let allBlocked = true;

    for (const [from, to] of invalidTransitions) {
      try {
        validateTransition(from as any, to as any);
        console.log(`   ❌ Transition allowed: ${from} → ${to} (should be blocked)`);
        allBlocked = false;
      } catch (err) {
        // Expected - transition blocked
      }
    }

    if (allBlocked) {
      pass('State machine enforcement', 'All invalid transitions blocked');
    } else {
      fail('State machine enforcement', 'Some invalid transitions were allowed');
    }
  } catch (err) {
    fail('State machine enforcement', (err as Error).message);
  }
}

// ============================================================================
// TEST 13: EDGE CASE - Acknowledge After Deadline
// ============================================================================

export async function test13AckAfterDeadline(pool: Pool): Promise<void> {
  console.log('\n' + '='.repeat(70));
  console.log('TEST 13: EDGE CASE - Acknowledge After Deadline');
  console.log('='.repeat(70));

  try {
    const jobId = await withTransaction(pool, async (ctx) => {
      const result = await ctx.query(
        'INSERT INTO jobs (title, capacity) VALUES ($1, $2) RETURNING id',
        ['Deadline Test', 1]
      );
      return result.rows[0].id;
    });

    const app = await applyToJob(pool, 'deadline@test.com', 'Deadline User', jobId);

    // Move deadline to past
    await withTransaction(pool, async (ctx) => {
      await ctx.query(
        `UPDATE applications SET ack_deadline = NOW() - INTERVAL '1 hour' WHERE id = $1`,
        [app.applicationId]
      );
    });

    // Try to acknowledge (should fail)
    try {
      await acknowledgeApplication(pool, app.applicationId);
      fail('ACK after deadline', 'Application acknowledged after deadline passed (should have failed)');
    } catch (err) {
      if ((err as Error).message.includes('DEADLINE_EXPIRED') || (err as Error).message.includes('deadline')) {
        pass('ACK after deadline', 'Correctly rejected: deadline check enforced');
      } else {
        fail('ACK after deadline', `Wrong error: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    fail('ACK after deadline', (err as Error).message);
  }
}

// ============================================================================
// TEST 14: EDGE CASE - Withdraw from Terminal State
// ============================================================================

export async function test14WithdrawFromTerminal(pool: Pool): Promise<void> {
  console.log('\n' + '='.repeat(70));
  console.log('TEST 14: EDGE CASE - Withdraw from Terminal State');
  console.log('='.repeat(70));

  try {
    const jobId = await withTransaction(pool, async (ctx) => {
      const result = await ctx.query(
        'INSERT INTO jobs (title, capacity) VALUES ($1, $2) RETURNING id',
        ['Terminal Test', 1]
      );
      return result.rows[0].id;
    });

    const app = await applyToJob(pool, 'terminal@test.com', 'Terminal User', jobId);
    await acknowledgeApplication(pool, app.applicationId);
    await exitApplication(pool, app.applicationId, 'HIRED');

    // Try to withdraw from HIRED (should fail)
    try {
      await withdrawApplication(pool, app.applicationId);
      fail('Withdraw from terminal', 'Withdraw from HIRED was allowed (should have failed)');
    } catch (err) {
      if ((err as Error).message.includes('INVALID') || (err as Error).message.includes('terminal')) {
        pass('Withdraw from terminal', 'Correctly rejected withdrawal from terminal state');
      } else {
        fail('Withdraw from terminal', `Wrong error: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    fail('Withdraw from terminal', (err as Error).message);
  }
}

// ============================================================================
// TEST 15: EDGE CASE - Capacity = 0 Job
// ============================================================================

export async function test15ZeroCapacityJob(pool: Pool): Promise<void> {
  console.log('\n' + '='.repeat(70));
  console.log('TEST 15: EDGE CASE - Zero Capacity Job (Should Fail)');
  console.log('='.repeat(70));

  try {
    // Try to create job with capacity 0 (should fail at DB level)
    const result = await withTransaction(pool, async (ctx) => {
      try {
        await ctx.query('INSERT INTO jobs (title, capacity) VALUES ($1, $2) RETURNING id', ['Zero Cap', 0]);
        return { success: true };
      } catch (err) {
        return { success: false, error: (err as Error).message };
      }
    });

    if (!result.success) {
      pass('Zero capacity job', 'Database constraint prevented zero-capacity job');
    } else {
      fail('Zero capacity job', 'Job with capacity=0 was created (should fail)', 'DB constraint not enforced');
    }
  } catch (err) {
    fail('Zero capacity job', (err as Error).message);
  }
}

// ============================================================================
// MAIN TEST RUNNER
// ============================================================================

export async function runAllStressTests(pool: Pool): Promise<void> {
  console.log('\n\n');
  console.log('╔' + '═'.repeat(68) + '╗');
  console.log('║' + ' '.repeat(15) + 'AGGRESSIVE STRESS TEST SUITE' + ' '.repeat(25) + '║');
  console.log('║' + ' '.repeat(20) + 'Attempting to Break the System' + ' '.repeat(18) + '║');
  console.log('╚' + '═'.repeat(68) + '╝');

  try {
    await test1RaceConditionLastSlot(pool);
    await test2DuplicateApplication(pool);
    await test3MultiJobApplication(pool);
    await test4AckFlow(pool);
    await test5Decay(pool);
    await test6CascadePromotion(pool);
    await test7QueueIntegrity(pool);
    await test8ConcurrentPromotion(pool);
    await test9Withdrawal(pool);
    await test10AuditLogging(pool);
    await test11LoadTest(pool);
    await test12StateMachineEnforcement(pool);
    await test13AckAfterDeadline(pool);
    await test14WithdrawFromTerminal(pool);
    await test15ZeroCapacityJob(pool);
  } catch (err) {
    console.error('\n❌ FATAL ERROR:', err);
  }

  // Print summary
  console.log('\n' + '='.repeat(70));
  console.log('TEST SUMMARY');
  console.log('='.repeat(70));

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  const total = results.length;

  console.log(`\nTotal: ${total} tests`);
  console.log(`✅ Passed: ${passed}`);
  console.log(`❌ Failed: ${failed}`);
  console.log(`Pass Rate: ${((passed / total) * 100).toFixed(1)}%`);

  if (failed > 0) {
    console.log(`\n${'─'.repeat(70)}`);
    console.log('FAILURES:');
    console.log('─'.repeat(70));
    results.filter((r) => !r.passed).forEach((r) => {
      console.log(`\n❌ ${r.name}`);
      if (r.error) console.log(`   Error: ${r.error}`);
      if (r.details) console.log(`   Details: ${r.details}`);
    });
  }

  console.log(`\n${'═'.repeat(70)}`);
  if (failed === 0) {
    console.log('✅ FINAL VERDICT: System is PRODUCTION-SAFE');
    console.log('═'.repeat(70));
    console.log('\nAll tests passed. No critical flaws detected.');
  } else {
    console.log(`❌ FINAL VERDICT: System has CRITICAL FLAWS`);
    console.log('═'.repeat(70));
    console.log(`\n${failed} test(s) failed. Review violations above.`);
    console.log('System is NOT production-ready.');
  }
  console.log('');
}
